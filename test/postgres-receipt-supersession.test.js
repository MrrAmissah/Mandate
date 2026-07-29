import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { PostgresSigningKeyRegistry } from '../src/crypto/signing-key-registry.js';
import { issueReceipt, verifyReceiptWithRegistry } from '../src/domain/receipts.js';
import { supersedeReceipt } from '../src/application/receipt-supersession-service.js';
import { saveReceiptForAttempt } from '../src/store/action-attempts.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const ownership = { tenantId: 'ten_receipt_supersession_pg', environment: 'test' };
const mandateId = 'mnd_receipt_supersession_pg';
const decisionId = 'dec_receipt_supersession_pg';
const attemptId = 'att_receipt_supersession_pg';
const credentialId = 'key_receipt_supersession_pg';

function mandate() {
  return {
    id: mandateId,
    principalId: 'principal_receipt_supersession_pg',
    agentId: 'agent_receipt_supersession_pg',
    purpose: 'Prove append-only receipt supersession',
    resources: ['github:MrrAmissah/Mandate'],
    allowedActions: ['repository.write'],
    deniedActions: [],
    approvalRequiredActions: [],
    constraints: {},
    validFrom: '2026-07-29T00:00:00.000Z',
    validUntil: '2030-01-01T00:00:00.000Z',
    maxUses: 10,
    uses: 1,
    status: 'ACTIVE',
    createdAt: '2026-07-29T00:00:00.000Z',
    revokedAt: null,
    revocationReason: null
  };
}

function decision() {
  return {
    id: decisionId,
    mandateId,
    agentId: 'agent_receipt_supersession_pg',
    action: 'repository.write',
    resource: 'github:MrrAmissah/Mandate',
    context: {},
    outcome: 'ALLOW',
    reasonCode: 'ACTION_ALLOWED',
    reason: 'The action is allowed.',
    approvalId: null,
    evaluatedAt: '2026-07-29T18:00:00.000Z',
    requestId: 'req_receipt_supersession_pg'
  };
}

async function seedExecution(store, pool, oldSigner) {
  await store.ensureBootstrap({
    ...ownership,
    tenantName: 'Receipt supersession PostgreSQL test',
    credential: {
      id: credentialId,
      name: 'Receipt supersession test credential',
      secretHash: '9'.repeat(64),
      prefix: 'pg_test_supersede',
      lastFour: '1234',
      scopes: ['receipts:read', 'receipts:write'],
      createdAt: '2026-07-29T17:00:00.000Z',
      expiresAt: null
    }
  });
  await store.save('mandates', ownership, mandate());
  await store.save('decisions', ownership, decision());
  await pool.query(
    `INSERT INTO mandate.action_attempts
      (tenant_id, environment, id, decision_id, mandate_id, agent_id, action, resource, status,
       reserved_by_credential_id, reserved_at, expires_at, request_id, version,
       execution_status, input_hash, output_hash, tool, provider, model, completed_at,
       completion_request_id, terminated_at, termination_reason, termination_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'COMPLETED',$9,$10,$11,$12,1,
       'SUCCEEDED',$13,$14,$15,$16,NULL,$17,$18,NULL,NULL,NULL)`,
    [ownership.tenantId, ownership.environment, attemptId, decisionId, mandateId,
      'agent_receipt_supersession_pg', 'repository.write', 'github:MrrAmissah/Mandate',
      credentialId, '2026-07-29T18:00:30.000Z', '2026-07-29T18:05:30.000Z',
      'req_reserve_receipt_supersession_pg', `sha256:${'a'.repeat(64)}`,
      `sha256:${'b'.repeat(64)}`, 'github.create_commit', 'github',
      '2026-07-29T18:01:00.000Z', 'req_complete_receipt_supersession_pg']
  );

  const root = issueReceipt({
    input: {
      actionAttemptId: attemptId,
      executionStatus: 'SUCCEEDED',
      inputHash: `sha256:${'a'.repeat(64)}`,
      outputHash: `sha256:${'b'.repeat(64)}`,
      tool: 'github.create_commit',
      provider: 'github',
      executedAt: '2026-07-29T18:01:00.000Z'
    },
    decision: decision(),
    mandate: mandate(),
    signer: oldSigner,
    now: new Date('2026-07-29T18:02:00.000Z')
  });
  await saveReceiptForAttempt(store, ownership, root);
  return root;
}

test('PostgreSQL receipt supersession has one winner, preserves history, and supports a linear chain', {
  skip: !connectionString
}, async () => {
  const pool = await createPostgresPool({ connectionString });
  try {
    await applyMigrations(pool, { logger: { log() {} } });
    const store = new PostgresStore(pool);
    const oldSigner = createReceiptSigner({ keyId: 'key_receipt_supersession_old' });
    const currentSigner = createReceiptSigner({ keyId: 'key_receipt_supersession_current' });
    const registry = new PostgresSigningKeyRegistry(pool, ownership, { retryDelay: async () => {} });
    await registry.registerActive({
      keyId: oldSigner.keyId,
      publicKeyPem: oldSigner.publicKeyPem,
      activatedAt: new Date('2026-07-29T17:00:00.000Z')
    });
    const root = await seedExecution(store, pool, oldSigner);
    await registry.registerActive({
      keyId: currentSigner.keyId,
      publicKeyPem: currentSigner.publicKeyPem,
      activatedAt: new Date('2026-07-29T18:03:00.000Z')
    });

    assert.equal(await verifyReceiptWithRegistry(root, registry), true);

    const attempts = await Promise.allSettled([
      store.transaction((transaction) => supersedeReceipt({
        transaction,
        ownership,
        receiptId: root.id,
        input: { reason: 'First concurrent correction' },
        signer: currentSigner,
        signingKeys: registry,
        now: new Date('2026-07-29T18:04:00.000Z')
      })),
      store.transaction((transaction) => supersedeReceipt({
        transaction,
        ownership,
        receiptId: root.id,
        input: { reason: 'Second concurrent correction' },
        signer: currentSigner,
        signingKeys: registry,
        now: new Date('2026-07-29T18:04:01.000Z')
      }))
    ]);

    const winners = attempts.filter((result) => result.status === 'fulfilled');
    const losers = attempts.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'RECEIPT_ALREADY_SUPERSEDED');

    const first = winners[0].value;
    assert.equal(first.supersedesReceiptId, root.id);
    assert.equal(first.keyId, currentSigner.keyId);
    assert.equal(first.actionAttemptId, root.actionAttemptId);
    assert.equal(first.inputHash, root.inputHash);
    assert.equal(first.outputHash, root.outputHash);
    assert.equal(first.executedAt, root.executedAt);
    assert.equal(await verifyReceiptWithRegistry(first, registry), true);

    const second = await store.transaction((transaction) => supersedeReceipt({
      transaction,
      ownership,
      receiptId: first.id,
      input: { reason: 'Advance the correction chain' },
      signer: currentSigner,
      signingKeys: registry,
      now: new Date('2026-07-29T18:05:00.000Z')
    }));
    assert.equal(second.supersedesReceiptId, first.id);
    assert.equal(second.actionAttemptId, root.actionAttemptId);
    assert.equal(await verifyReceiptWithRegistry(second, registry), true);

    const rows = await pool.query(
      `SELECT id, payload, signature, supersedes_receipt_id
       FROM mandate.receipts
       WHERE tenant_id = $1 AND environment = $2 AND action_attempt_id = $3
       ORDER BY issued_at, id`,
      [ownership.tenantId, ownership.environment, attemptId]
    );
    assert.equal(rows.rowCount, 3);
    assert.equal(rows.rows.filter((row) => row.supersedes_receipt_id === null).length, 1);
    assert.equal(rows.rows.filter((row) => row.supersedes_receipt_id === root.id).length, 1);
    assert.equal(rows.rows.filter((row) => row.supersedes_receipt_id === first.id).length, 1);
    const persistedRoot = rows.rows.find((row) => row.id === root.id);
    assert.deepEqual({ ...persistedRoot.payload, signature: persistedRoot.signature }, root);
  } finally {
    await pool.end();
  }
});
