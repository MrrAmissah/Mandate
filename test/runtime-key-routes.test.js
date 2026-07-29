import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { API_SCOPES, createStaticApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { createRuntimeHandler } from '../src/http/runtime-handler.js';
import { MemoryStore } from '../src/store/memory-store.js';

function keyRecord(signer, status, activatedAt, retiredAt = null) {
  return {
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    publicKeyPem: signer.publicKeyPem,
    fingerprint: `sha256:${signer.keyId.padEnd(64, '0').slice(0, 64)}`,
    status,
    activatedAt,
    retiredAt,
    revokedAt: null,
    revocationReason: null
  };
}

function signingKeyRegistry(records, signers) {
  const byId = new Map(signers.map((signer) => [signer.keyId, signer]));
  return {
    async listDiscoverable() {
      return structuredClone(records.filter((record) => ['ACTIVE', 'RETIRED'].includes(record.status)));
    },
    async verifyPayload({ keyId, algorithm, payload, signature }) {
      const record = records.find((candidate) => candidate.keyId === keyId && candidate.algorithm === algorithm);
      if (!record || !['ACTIVE', 'RETIRED'].includes(record.status)) return false;
      return byId.get(keyId)?.verifyPayload(payload, signature) ?? false;
    }
  };
}

async function startRuntimeServer(runtime) {
  const server = createServer(createRuntimeHandler(runtime));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

function runtimeFixture() {
  const active = createReceiptSigner({ keyId: 'key_active_2026_07' });
  const retired = createReceiptSigner({ keyId: 'key_retired_2026_06' });
  const revoked = createReceiptSigner({ keyId: 'key_revoked_2026_05' });
  const records = [
    keyRecord(active, 'ACTIVE', '2026-07-01T00:00:00.000Z'),
    keyRecord(retired, 'RETIRED', '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    { ...keyRecord(revoked, 'REVOKED', '2026-05-01T00:00:00.000Z'), revokedAt: '2026-06-01T00:00:00.000Z' }
  ];
  return {
    active,
    retired,
    revoked,
    runtime: {
      store: new MemoryStore({ tenantId: 'ten_key_routes', environment: 'test' }),
      signer: active,
      signingKeys: signingKeyRegistry(records, [active, retired, revoked]),
      authenticator: createStaticApiKeyAuthenticator({
        apiKey: 'runtime-key-route-secret',
        tenantId: 'ten_key_routes',
        environment: 'test',
        scopes: [API_SCOPES.RECEIPTS_READ]
      })
    }
  };
}

test('key discovery publishes active and retired keys without revoked material', async () => {
  const fixture = runtimeFixture();
  const server = await startRuntimeServer(fixture.runtime);
  try {
    const response = await fetch(`${server.baseUrl}/.well-known/mandate-keys`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    const body = await response.json();
    assert.deepEqual(body.keys.map((key) => [key.keyId, key.status]), [
      ['key_active_2026_07', 'ACTIVE'],
      ['key_retired_2026_06', 'RETIRED']
    ]);
    assert.equal(body.keys.some((key) => 'revocationReason' in key), false);
    assert.match(body.requestId, /^req_/);
  } finally {
    await server.close();
  }
});

test('receipt verification resolves retired keys and rejects revoked keys', async () => {
  const fixture = runtimeFixture();
  const server = await startRuntimeServer(fixture.runtime);
  try {
    for (const [signer, expected] of [[fixture.retired, true], [fixture.revoked, false]]) {
      const payload = {
        id: `rcpt_${signer.keyId}`,
        version: '1.0',
        keyId: signer.keyId,
        algorithm: signer.algorithm,
        decisionId: 'dec_test',
        mandateId: 'mnd_test'
      };
      const receipt = { ...payload, signature: signer.signPayload(payload) };
      const response = await fetch(`${server.baseUrl}/v1/receipts/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'runtime-key-route-secret'
        },
        body: JSON.stringify({ receipt })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        valid: expected,
        keyId: signer.keyId,
        algorithm: 'Ed25519'
      });
    }
  } finally {
    await server.close();
  }
});

test('receipt verification preserves receipt-read scope enforcement', async () => {
  const fixture = runtimeFixture();
  fixture.runtime.authenticator = createStaticApiKeyAuthenticator({
    apiKey: 'wrong-scope-secret',
    tenantId: 'ten_key_routes',
    environment: 'test',
    scopes: [API_SCOPES.MANDATES_READ]
  });
  const server = await startRuntimeServer(fixture.runtime);
  try {
    const response = await fetch(`${server.baseUrl}/v1/receipts/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'wrong-scope-secret'
      },
      body: JSON.stringify({ receipt: {} })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'MISSING_SCOPE');
  } finally {
    await server.close();
  }
});
