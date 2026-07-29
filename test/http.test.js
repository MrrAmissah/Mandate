import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { MemoryStore } from '../src/store/memory-store.js';

async function withServer(run) {
  const server = createServer(createApp({
    store: new MemoryStore(),
    signer: createReceiptSigner({ keyId: 'test' }),
    apiKey: 'secret',
    now: () => new Date('2026-07-29T06:00:00.000Z')
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

test('HTTP flow creates a mandate and returns an authorization decision', async () => {
  await withServer(async (baseUrl) => {
    const mandateResponse = await fetch(`${baseUrl}/v1/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      body: JSON.stringify({
        principalId: 'user_prince',
        agentId: 'agent_coder',
        purpose: 'Read a repository',
        resources: ['github:MrrAmissah/demo-api'],
        allowedActions: ['repository.read']
      })
    });
    assert.equal(mandateResponse.status, 201);
    const mandate = await mandateResponse.json();

    const authorizationResponse = await fetch(`${baseUrl}/v1/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
      body: JSON.stringify({
        mandateId: mandate.id,
        agentId: 'agent_coder',
        action: 'repository.read',
        resource: 'github:MrrAmissah/demo-api'
      })
    });
    assert.equal(authorizationResponse.status, 200);
    const decision = await authorizationResponse.json();
    assert.equal(decision.outcome, 'ALLOW');
  });
});
