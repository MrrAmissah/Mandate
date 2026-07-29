import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { issueReceipt } from '../src/domain/receipts.js';
import { saveReceiptForAttempt } from '../src/store/action-attempts.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const connectionString = process.env.DATABASE_URL;
const ownership = { tenantId: 'ten_receipt_shape_pg', environment: 'test' };
const mandateId = 'mnd_receipt_shape_pg';
const decisionId = 'dec_receipt_shape_pg';
const attemptId = 'att_receipt_shape_pg';
const credentialId = 'key_receipt_shape_pg';

function mandate() {
  return {
    id: mandateId,
    principalId: 'principal_receipt_shape_pg',
    agentId: 'agent_receipt_shape_pg',
    purpose: 'Prove receipt chain payload alignment',
    resources: ['github:MrrAmissah/Mandate'],
    allowedActions: ['repository.write'],
    deniedActions: [],
    approvalRequiredActions: [],
    constraints: {},
    validFrom: '2026-07-29T00:00:00.000Z',
    validUntil: '2030-01-01T00:00:00.000Z',
    maxUses: 1,
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
    agentId: 'agent_receipt_shape_pg',
    action: 'repository.write',
    resource: 'github:MrrAmissah/Mandate',
    context: {},
    outcome: 'ALLOW',
    reasonCode: 'ACTION_ALLOWED',
    reason: 'The action is allowed.',
    approvalId: null,
    evaluatedAt: '2026-07-29T18:00:00.000Z',
    requestId: 'req_receipt_shape_pg'
  };
}

test('PostgreSQL rejects successor rows whose signed payload omits chain identity fields', {
  skip: !connectionString
}, async () => {
  const pool = await createPostgresPool({ connectionString });
  try {
    await applyMigrations(pool, { logger: { log() {} } });
    const store = new PostgresStore(pool);
    await store.ensureBootstrap({
      ...ownership,
      tenantName: 'Receipt shape PostgreSQL test',
      credential: {
        id: credentialId,
        name: 'Receipt shape test credential',
        secretHash: '8'.repeat(64),
        prefix: 'pg_test_shape',
        lastFour: '5678',
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
         'SUCCEEDED',$13,$14,$15,NULL,NULL,$16,$17,NULL,NULL,NULL)`,
      [ownership.tenantId, ownership.environment, attemptId, decisionId, mandateId,
        'agent_receipt_shape_pg', 'repository.write', 'github:MrrAmissah/Mandate',
        credentialId, '2026-07-29T18:00:30.000Z', '2026-07-29T18:05:30.000Z',
        'req_reserve_receipt_shape_pg', `sha256:${'1'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`, 'github.create_commit',
        '2026-07-29T18:01:00.000Z', 'req_complete_receipt_shape_pg']
    );

    const signer = createReceiptSigner({ keyId: 'key_receipt_shape_signer' });
    const root = issueReceipt({
      input: {
        actionAttemptId: attemptId,
        executionStatus: 'SUCCEEDED',
        inputHash: `sha256:${'1'.repeat(64)}`,
        outputHash: `sha256:${'2'.repeat(64)}`,
        tool: 'github.create_commit',
        executedAt: '2026-07-29T18:01:00.000Z'
      },
      decision: decision(),
      mandate: mandate(),
      signer,
      now: new Date('2026-07-29T18:02:00.000Z')
    });
    await saveReceiptForAttempt(store, ownership, root);

    await assert.rejects(
      pool.query(
        `INSERT INTO mandate.receipts
          (tenant_id, environment, id, decision_id, mandate_id, action_attempt_id, key_id,
           algorithm, payload, signature, issued_at, supersedes_receipt_id, supersession_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Ed25519','{}'::jsonb,$8,$9,$10,$11)`,
        [ownership.tenantId, ownership.environment, 'rcpt_receipt_shape_missing_payload',
          decisionId, mandateId, attemptId, signer.keyId, 'invalid-signature',
          '2026-07-29T18:03:00.000Z', root.id, 'Missing signed payload fields']
      ),
      (error) => error.code === '23514' && error.constraint === 'receipts_supersession_shape'
    );
  } finally {
    await pool.end();
  }
});
