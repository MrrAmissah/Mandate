import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActionAttemptExpiryWorker } from '../src/application/action-attempt-expiry-worker.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('PostgreSQL expiry workers materialize one due reservation exactly once using database time', async () => {
  const pool = await createPostgresPool({ connectionString: databaseUrl, max: 8 });
  const store = new PostgresStore(pool);
  const suffix = randomUUID().replaceAll('-', '');
  const tenantId = `ten_expiry_${suffix}`;
  const environment = 'test';
  const credentialId = `key_expiry_${suffix}`;
  const mandateId = `mnd_expiry_${suffix}`;
  const decisionId = `dec_expiry_${suffix}`;
  const attemptId = `att_expiry_${suffix}`;
  const futureDecisionId = `dec_expiry_future_${suffix}`;
  const futureAttemptId = `att_expiry_future_${suffix}`;

  try {
    await applyMigrations(pool, { logger: { log() {} } });
    await pool.query(
      `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
       VALUES ($1, 'Expiry tenant', 'ACTIVE', clock_timestamp(), clock_timestamp())`,
      [tenantId]
    );
    await pool.query(
      `INSERT INTO mandate.api_credentials
        (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status, created_at)
       VALUES ($1,$2,$3,'Expiry credential',$4,'mnd_test_','0002',$5,'ACTIVE',clock_timestamp())`,
      [tenantId, environment, credentialId, suffix.padEnd(64, '2'), ['action_attempts:write']]
    );
    await pool.query(
      `INSERT INTO mandate.mandates
        (tenant_id, environment, id, status, principal_id, agent_id, purpose, resources,
         allowed_actions, denied_actions, approval_required_actions, constraints, valid_from,
         valid_until, max_uses, uses, version, created_at)
       VALUES ($1,$2,$3,'ACTIVE','principal_expiry','agent_expiry','Expire reservations',
         $4,$5,$6,$6,clock_timestamp() - interval '1 hour',clock_timestamp() + interval '1 day',10,2,0,clock_timestamp())`,
      [tenantId, environment, mandateId, JSON.stringify(['github:repo']),
        JSON.stringify(['repository.write']), JSON.stringify([])]
    );
    for (const decision of [decisionId, futureDecisionId]) {
      await pool.query(
        `INSERT INTO mandate.authorization_decisions
          (tenant_id, environment, id, mandate_id, agent_id, action, resource, context, outcome,
           reason_code, reason, approval_id, evaluated_at, request_id)
         VALUES ($1,$2,$3,$4,'agent_expiry','repository.write','github:repo',$5,'ALLOW',
           'ACTION_ALLOWED','The action is allowed.',NULL,clock_timestamp(),$6)`,
        [tenantId, environment, decision, mandateId, JSON.stringify({}), `req_${decision}`]
      );
    }
    await pool.query(
      `INSERT INTO mandate.action_attempts
        (tenant_id, environment, id, decision_id, mandate_id, agent_id, action, resource, status,
         reserved_by_credential_id, reserved_at, expires_at, request_id, version)
       VALUES
        ($1,$2,$3,$4,$5,'agent_expiry','repository.write','github:repo','RESERVED',$6,
         clock_timestamp() - interval '10 minutes',clock_timestamp() - interval '1 second','req_due',0),
        ($1,$2,$7,$8,$5,'agent_expiry','repository.write','github:repo','RESERVED',$6,
         clock_timestamp(),clock_timestamp() + interval '1 hour','req_future',0)`,
      [tenantId, environment, attemptId, decisionId, mandateId, credentialId, futureAttemptId, futureDecisionId]
    );

    const workerA = new ActionAttemptExpiryWorker({
      store,
      workerId: 'expiry-worker-pg-a',
      scope: { tenantId, environment },
      now: () => new Date('2000-01-01T00:00:00.000Z')
    });
    const workerB = new ActionAttemptExpiryWorker({
      store,
      workerId: 'expiry-worker-pg-b',
      scope: { tenantId, environment },
      now: () => new Date('2000-01-01T00:00:00.000Z')
    });

    const results = await Promise.all([workerA.pollOnce(), workerB.pollOnce()]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['EXPIRED', 'IDLE']);
    const expired = results.find((result) => result.status === 'EXPIRED').actionAttempt;
    assert.equal(expired.id, attemptId);
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(expired.terminationReason, 'RESERVATION_EXPIRED');
    assert.ok(Date.parse(expired.terminatedAt) > Date.parse('2026-01-01T00:00:00.000Z'));

    const attempts = await pool.query(
      `SELECT id, status, termination_reason FROM mandate.action_attempts
       WHERE tenant_id = $1 AND environment = $2 ORDER BY id`,
      [tenantId, environment]
    );
    assert.equal(attempts.rows.find((row) => row.id === attemptId).status, 'EXPIRED');
    assert.equal(attempts.rows.find((row) => row.id === futureAttemptId).status, 'RESERVED');

    const audit = await pool.query(
      `SELECT actor_type, actor_id, type FROM mandate.audit_events
       WHERE tenant_id = $1 AND environment = $2 AND object_id = $3`,
      [tenantId, environment, attemptId]
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_type, 'SYSTEM');
    assert.match(audit.rows[0].actor_id, /^expiry-worker-pg-/);
    assert.equal(audit.rows[0].type, 'action_attempt.expired');

    const outbox = await pool.query(
      `SELECT event_type FROM mandate.outbox_messages
       WHERE tenant_id = $1 AND environment = $2 AND aggregate_id = $3`,
      [tenantId, environment, attemptId]
    );
    assert.equal(outbox.rowCount, 1);
    assert.equal(outbox.rows[0].event_type, 'action_attempt.expired');
  } finally {
    await store.close();
  }
});
