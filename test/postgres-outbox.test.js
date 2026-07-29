import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import {
  assertCredentialUsable,
  createApiCredentialRecord,
  hashApiKey,
  verifyApiKey
} from '../src/auth/api-credentials.js';
import { createStoredApiKeyAuthenticator } from '../src/auth/authentication.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { OutboxDispatcher } from '../src/outbox/dispatcher.js';
import { PostgresOutboxQueue } from '../src/outbox/postgres-outbox-queue.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const integration = connectionString ? test : test.skip;
const eventTime = new Date('2026-07-29T08:00:00.000Z');
const signer = createReceiptSigner({ keyId: 'outbox-integration-ed25519' });

function unique(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

async function createHarness() {
  const pool = await createPostgresPool({ connectionString, max: 12 });
  const store = new PostgresStore(pool);
  const tenantId = unique('ten_outbox');
  const credentialId = unique('key_outbox');
  const secret = `outbox-secret-${randomUUID()}`;
  const credential = createApiCredentialRecord({
    id: credentialId,
    tenantId,
    environment: 'test',
    name: 'Outbox integration credential',
    scopes: ['*']
  }, secret, eventTime);
  await store.ensureBootstrap({ tenantId, tenantName: 'Outbox tenant', environment: 'test', credential });
  const authenticator = createStoredApiKeyAuthenticator({
    store,
    hashApiKey,
    verifyApiKey,
    assertCredentialUsable,
    now: () => eventTime
  });
  return {
    pool,
    store,
    queue: new PostgresOutboxQueue(pool),
    tenantId,
    owner: { tenantId, environment: 'test' },
    secret,
    authenticator,
    async close() {
      await store.close();
    }
  };
}

async function withServer(harness, run) {
  const server = createServer(createApp({
    store: harness.store,
    signer,
    authenticator: harness.authenticator,
    now: () => eventTime
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

async function createMandateEvent(harness, suffix = randomUUID()) {
  await withServer(harness, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/mandates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': harness.secret
      },
      body: JSON.stringify({
        principalId: 'principal_owner',
        agentId: 'agent_worker',
        purpose: `Outbox test ${suffix}`,
        resources: [`github:owner/repository-${suffix}`],
        allowedActions: ['repository.read']
      })
    });
    assert.equal(response.status, 201);
  });
  const messages = await harness.store.list('outboxMessages', harness.owner);
  return messages.at(-1);
}

integration('outbox migration registry and immutable attempt table exist', async () => {
  const harness = await createHarness();
  try {
    const migration = await harness.pool.query(
      "SELECT 1 FROM mandate.schema_migrations WHERE version = '002_outbox_attempts'"
    );
    assert.equal(migration.rowCount, 1);
    const table = await harness.pool.query("SELECT to_regclass('mandate.outbox_attempts') AS name");
    assert.equal(table.rows[0].name, 'mandate.outbox_attempts');
  } finally {
    await harness.close();
  }
});

integration('unregistered event types remain pending and unclaimed', async () => {
  const harness = await createHarness();
  try {
    const message = await createMandateEvent(harness);
    const dispatcher = new OutboxDispatcher({
      queue: harness.queue,
      workerId: 'worker_unregistered',
      handlers: { 'receipt.issued': async () => {} },
      now: () => eventTime
    });

    assert.deepEqual(await dispatcher.pollOnce(), { kind: 'IDLE', reason: 'NO_DUE_MESSAGES' });
    const stored = await harness.store.get('outboxMessages', harness.owner, message.id);
    assert.equal(stored.status, 'PENDING');
    assert.equal(stored.attemptCount, 0);
    assert.deepEqual(await harness.queue.listAttempts(harness.owner, message.id), []);
  } finally {
    await harness.close();
  }
});

integration('successful delivery is processed once with immutable attempt evidence', async () => {
  const harness = await createHarness();
  try {
    const message = await createMandateEvent(harness);
    const delivered = [];
    const dispatcher = new OutboxDispatcher({
      queue: harness.queue,
      workerId: 'worker_success',
      handlers: {
        'mandate.created': async (payload) => delivered.push(payload)
      },
      now: () => eventTime
    });

    assert.equal((await dispatcher.pollOnce()).kind, 'PROCESSED');
    assert.equal(delivered.length, 1);
    assert.equal((await dispatcher.pollOnce()).kind, 'IDLE');

    const stored = await harness.store.get('outboxMessages', harness.owner, message.id);
    assert.equal(stored.status, 'PROCESSED');
    assert.equal(stored.attemptCount, 1);
    const attempts = await harness.queue.listAttempts(harness.owner, message.id);
    assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['SUCCEEDED']);

    await assert.rejects(
      harness.pool.query(
        `UPDATE mandate.outbox_attempts SET error_code = 'TAMPERED'
         WHERE tenant_id = $1 AND environment = 'test' AND outbox_message_id = $2`,
        [harness.tenantId, message.id]
      ),
      (error) => error.code === '55000'
    );
  } finally {
    await harness.close();
  }
});

integration('failed handlers retry with backoff and dead-letter at the configured limit', async () => {
  const harness = await createHarness();
  try {
    const message = await createMandateEvent(harness);
    let current = new Date(eventTime);
    const dispatcher = new OutboxDispatcher({
      queue: harness.queue,
      workerId: 'worker_failure',
      handlers: {
        'mandate.created': async () => {
          const error = new Error('private provider body');
          error.code = 'temporary_failure';
          throw error;
        }
      },
      now: () => new Date(current),
      leaseMs: 10_000,
      maxAttempts: 2,
      baseDelayMs: 1_000,
      maximumDelayMs: 1_000
    });

    const first = await dispatcher.pollOnce();
    assert.equal(first.kind, 'RETRY_SCHEDULED');
    assert.equal(first.message.status, 'PENDING');
    assert.equal(first.message.lastErrorCode, 'TEMPORARY_FAILURE');

    current = new Date(eventTime.getTime() + 1_000);
    const second = await dispatcher.pollOnce();
    assert.equal(second.kind, 'DEAD_LETTERED');
    assert.equal(second.message.status, 'DEAD_LETTER');
    assert.equal(second.message.attemptCount, 2);

    const attempts = await harness.queue.listAttempts(harness.owner, message.id);
    assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['FAILED', 'DEAD_LETTER']);
    assert.ok(attempts.every((attempt) => attempt.errorCode === 'TEMPORARY_FAILURE'));
  } finally {
    await harness.close();
  }
});

integration('expired leases are recovered and the old worker cannot overwrite the new owner', async () => {
  const harness = await createHarness();
  try {
    const message = await createMandateEvent(harness);
    const firstClaim = await harness.queue.claim({
      workerId: 'worker_old',
      eventTypes: ['mandate.created'],
      now: eventTime,
      leaseMs: 1_000,
      maxAttempts: 3
    });
    assert.equal(firstClaim.kind, 'CLAIMED');

    const recoveryTime = new Date(eventTime.getTime() + 1_001);
    const secondClaim = await harness.queue.claim({
      workerId: 'worker_new',
      eventTypes: ['mandate.created'],
      now: recoveryTime,
      leaseMs: 5_000,
      maxAttempts: 3
    });
    assert.equal(secondClaim.kind, 'CLAIMED');
    assert.equal(secondClaim.message.attemptCount, 2);

    const oldCompletion = await harness.queue.succeed(firstClaim.message, {
      workerId: 'worker_old',
      now: new Date(recoveryTime.getTime() + 100)
    });
    assert.equal(oldCompletion.kind, 'LEASE_LOST');
    assert.equal(oldCompletion.message.lockedBy, 'worker_new');

    const newCompletion = await harness.queue.succeed(secondClaim.message, {
      workerId: 'worker_new',
      now: new Date(recoveryTime.getTime() + 200)
    });
    assert.equal(newCompletion.kind, 'PROCESSED');

    const attempts = await harness.queue.listAttempts(harness.owner, message.id);
    assert.deepEqual(
      attempts.map((attempt) => `${attempt.attemptNumber}:${attempt.outcome}`).sort(),
      ['1:LEASE_EXPIRED', '1:LEASE_LOST', '2:SUCCEEDED']
    );
  } finally {
    await harness.close();
  }
});

integration('concurrent workers claim different messages with SKIP LOCKED', async () => {
  const harness = await createHarness();
  try {
    await createMandateEvent(harness, 'one');
    await createMandateEvent(harness, 'two');
    const handled = [];
    const handler = async (_payload, message) => {
      handled.push(message.id);
    };
    const first = new OutboxDispatcher({
      queue: new PostgresOutboxQueue(harness.pool),
      workerId: 'worker_parallel_one',
      handlers: { 'mandate.created': handler },
      now: () => eventTime
    });
    const second = new OutboxDispatcher({
      queue: new PostgresOutboxQueue(harness.pool),
      workerId: 'worker_parallel_two',
      handlers: { 'mandate.created': handler },
      now: () => eventTime
    });

    const results = await Promise.all([first.pollOnce(), second.pollOnce()]);
    assert.deepEqual(results.map((result) => result.kind), ['PROCESSED', 'PROCESSED']);
    assert.equal(new Set(handled).size, 2);
    const messages = await harness.store.list('outboxMessages', harness.owner);
    assert.equal(messages.filter((value) => value.status === 'PROCESSED').length, 2);
  } finally {
    await harness.close();
  }
});
