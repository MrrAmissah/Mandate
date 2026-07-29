import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reserveActionAttempt } from '../src/application/action-attempt-service.js';
import { completeAttempt, issueAttemptReceipt } from '../src/application/attempt-lifecycle-service.js';
import { createReceiptSigner } from '../src/crypto/receipt-signer.js';
import { verifyReceipt } from '../src/domain/receipts.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('PostgreSQL binds one receipt to one completed action attempt', async () => {
  const pool = await createPostgresPool({ connectionString: databaseUrl });
  const store = new PostgresStore(pool);
  const suffix = randomUUID().replaceAll('-', '');
  const tenantId = `ten_complete_${suffix}`;
  const environment = 'test';
  const ownership = { tenantId, environment };
  const credentialId = `key_complete_${suffix}`;
  const mandateId = `mnd_complete_${suffix}`;
  const decisionId = `dec_complete_${suffix}`;
  const authentication = { tenantId, environment, credentialId, scopes: ['action_attempts:write', 'receipts:write'] };
  const signer = createReceiptSigner({ keyId: `key_sign_${suffix}` });
  const observedAt = new Date('2026-07-29T12:00:00.000Z');

  try {
    await applyMigrations(pool, { logger: { log() {} } });
    await pool.query(
      `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
       VALUES ($1,'Completion tenant','ACTIVE',$2,$2)`,
      [tenantId, observedAt.toISOString()]
    );
    await pool.query(
      `INSERT INTO mandate.api_credentials
        (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status, created_at)
       VALUES ($1,$2,$3,'Completion credential',$4,'mnd_test_','0001',$5,'ACTIVE',$6)`,
      [tenantId, environment, credentialId, suffix.padEnd(64, '1'),
        ['action_attempts:write', 'receipts:write'], observedAt.toISOString()]
    );
    await pool.query(
      `INSERT INTO mandate.mandates
        (tenant_id, environment, id, status, principal_id, agent_id, purpose, resources,
         allowed_actions, denied_actions, approval_required_actions, constraints, valid_from,
         valid_until, max_uses, uses, version, created_at)
       VALUES ($1,$2,$3,'ACTIVE','principal_pg','agent_pg','Complete one protected action',
         $4,$5,$6,$6,$7,$8,$9,5,1,0,$8)`,
      [tenantId, environment, mandateId, JSON.stringify(['github:repo']),
        JSON.stringify(['repository.write']), JSON.stringify([]), JSON.stringify({}),
        observedAt.toISOString(), '2030-01-01T00:00:00.000Z']
    );
    await pool.query(
      `INSERT INTO mandate.authorization_decisions
        (tenant_id, environment, id, mandate_id, agent_id, action, resource, context, outcome,
         reason_code, reason, approval_id, evaluated_at, request_id)
       VALUES ($1,$2,$3,$4,'agent_pg','repository.write','github:repo',$5,'ALLOW',
         'ACTION_ALLOWED','The action is allowed.',NULL,$6,'req_pg_complete_authorize')`,
      [tenantId, environment, decisionId, mandateId, JSON.stringify({}), observedAt.toISOString()]
    );

    const attempt = await store.transaction((transaction) => reserveActionAttempt({
      transaction,
      ownership,
      authentication,
      input: { decisionId, expiresInSeconds: 300 },
      requestId: 'req_pg_reserve',
      now: observedAt
    }));
    const completedAt = new Date(observedAt.getTime() + 10_000);
    const completed = await store.transaction((transaction) => completeAttempt({
      transaction,
      ownership,
      attemptId: attempt.id,
      input: {
        executionStatus: 'SUCCEEDED',
        inputHash: `sha256:${'a'.repeat(64)}`,
        outputHash: `sha256:${'b'.repeat(64)}`,
        tool: 'github.create_commit',
        provider: 'github'
      },
      requestId: 'req_pg_complete',
      now: completedAt
    }));
    assert.equal(completed.status, 'COMPLETED');

    await pool.query(
      `UPDATE mandate.mandates
       SET status = 'REVOKED', revoked_at = $4, revocation_reason = 'No new execution'
       WHERE tenant_id = $1 AND environment = $2 AND id = $3`,
      [tenantId, environment, mandateId, new Date(completedAt.getTime() + 1000).toISOString()]
    );

    const issue = () => store.transaction((transaction) => issueAttemptReceipt({
      transaction,
      ownership,
      input: { actionAttemptId: attempt.id },
      signer,
      now: new Date(completedAt.getTime() + 2000)
    }));
    const results = await Promise.allSettled([issue(), issue()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'RECEIPT_ALREADY_EXISTS');

    const receipt = results.find((result) => result.status === 'fulfilled').value;
    assert.equal(receipt.actionAttemptId, attempt.id);
    assert.equal(receipt.version, '1.1');
    assert.equal(receipt.executedAt, completed.completedAt);
    assert.equal(verifyReceipt(receipt, signer), true);

    const stored = await pool.query(
      `SELECT action_attempt_id, decision_id FROM mandate.receipts
       WHERE tenant_id = $1 AND environment = $2`,
      [tenantId, environment]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].action_attempt_id, attempt.id);
    assert.equal(stored.rows[0].decision_id, decisionId);
  } finally {
    await store.close();
  }
});
