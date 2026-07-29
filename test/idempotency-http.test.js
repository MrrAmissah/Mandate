import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { MemoryStore } from '../src/store/memory-store.js';

const apiKey = 'idempotency-http-secret';
const fixedNow = new Date('2026-07-29T09:30:00.000Z');

async function withServer(run) {
  const server = createServer(createApp({
    store: new MemoryStore(),
    signer: createReceiptSigner({ keyId: 'idempotency-http-test' }),
    apiKey,
    now: () => fixedNow
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function stableHeaders(response) {
  return {
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    cacheControl: response.headers.get('cache-control'),
    contentTypeOptions: response.headers.get('x-content-type-options')
  };
}

async function createMandate(baseUrl, requestId, body) {
  const response = await fetch(`${baseUrl}/v1/mandates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-request-id': requestId,
      'idempotency-key': 'idem_http_exact_replay'
    },
    body: JSON.stringify(body)
  });
  return { response, text: await response.text() };
}

test('idempotent retries reproduce canonical response bytes, status, and stable headers', async () => {
  await withServer(async (baseUrl) => {
    const body = {
      allowedActions: ['repository.read'],
      purpose: 'Prove exact replay',
      resources: ['github:owner/repository'],
      agentId: 'agent_coder',
      principalId: 'principal_owner'
    };
    const first = await createMandate(baseUrl, 'req_first_exact_001', body);
    const replay = await createMandate(baseUrl, 'req_replay_exact_002', body);

    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 201);
    assert.equal(replay.text, first.text);
    assert.deepEqual(stableHeaders(replay.response), stableHeaders(first.response));
    assert.equal(first.response.headers.get('x-request-id'), 'req_first_exact_001');
    assert.equal(replay.response.headers.get('x-request-id'), 'req_replay_exact_002');
    assert.notEqual(
      first.response.headers.get('x-request-id'),
      replay.response.headers.get('x-request-id')
    );

    const parsed = JSON.parse(first.text);
    assert.equal(parsed.purpose, 'Prove exact replay');
    assert.match(first.text, /^\{"agentId":/);
  });
});

test('idempotency key reuse with a different payload remains a conflict', async () => {
  await withServer(async (baseUrl) => {
    const original = {
      principalId: 'principal_owner',
      agentId: 'agent_coder',
      purpose: 'Original request',
      resources: ['github:owner/repository'],
      allowedActions: ['repository.read']
    };
    assert.equal((await createMandate(baseUrl, 'req_original_001', original)).response.status, 201);

    const conflict = await createMandate(baseUrl, 'req_conflict_002', {
      ...original,
      purpose: 'Different request'
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(JSON.parse(conflict.text).error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.response.headers.get('x-request-id'), 'req_conflict_002');
  });
});
