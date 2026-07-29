import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspectActionAttemptExpiryBacklog } from '../src/store/action-attempts.js';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { createPostgresPool, PostgresStore } from '../src/store/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('PostgreSQL expiry backlog uses database time and excludes future or terminal attempts', async () => {
  const pool = await createPostgresPool({ connectionString: databaseUrl });
  const store = new PostgresStore(pool);
  const suffix = randomUUID().replaceAll('-', '');
  const tenantId = `ten_backlog_${suffix}`;
  const environment = 'test';
  const credentialId = `key_backlog_${suffix}`;
  const mandateId = `mnd_backlog_${suffix}`;
  const decisionIds = [
    `dec_backlog_due_${suffix}`,
    `dec_backlog_future_${suffix}`,
    `dec_backlog_terminal_${suffix}`
  ];
  const attemptIds = [
    `att_backlog_due_${suffix}`,
    `att_backlog_future_${suffix}`,
    `att_backlog_terminal_${suffix}`
  ];

  try {
    await applyMigrations(pool, { logger: { log() {} } });
    const empty = await inspectActionAttemptExpiryBacklog(store, {
      tenantId: `ten_empty_${suffix}`,
      environment
    });
    assert.equal(empty.reservedCount, 0);
    assert.equal(empty.dueCount, 0);
    assert.equal(empty.oldestDueAt, null);
    assert.equal(empty.oldestOverdueSeconds, 0);

    await pool.query(
      `INSERT INTO mandate.tenants (id, name, status, created_at, updated_at)
       VALUES ($1, 'Backlog tenant', 'ACTIVE', clock_timestamp(), clock_timestamp())`,
      [tenantId]
    );
    await pool.query(
      `INSERT INTO mandate.api_credentials
        (tenant_id, environment, id, name, secret_hash, prefix, last_four, scopes, status, created_at)
       VALUES ($1,$2,$3,'Backlog credential',$4,'mnd_test_','0003',$5,'ACTIVE',clock_timestamp())`,
      [tenantId, environment, credentialId, suffix.padEnd(64, '3'), ['action_attempts:write']]
    );
    await pool.query(
      `INSERT INTO mandate.mandates
        (tenant_id, environment, id, status, principal_id, agent_id, purpose, resources,
         allowed_actions, denied_actions, approval_required_actions, constraints, valid_from,
         valid_until, max_uses, uses, version, created_at)
       VALUES ($1,$2,$3,'ACTIVE','principal_backlog','agent_backlog','Measure expiry backlog',
         $4,$5,$6,$6,$7,clock_timestamp() - interval '1 hour',clock_timestamp() + interval '1 day',10,3,0,clock_timestamp())`,
      [tenantId, environment, mandateId, JSON.stringify(['github:repo']),
        JSON.stringify(['repository.write']), JSON.stringify([]), JSON.stringify({})]
    );
    for (const decisionId of decisionIds) {
      await pool.query(
        `INSERT INTO mandate.authorization_decisions
          (tenant_id, environment, id, mandate_id, agent_id, action, resource, context, outcome,
           reason_code, reason, approval_id, evaluated_at, request_id)
         VALUES ($1,$2,$3,$4,'agent_backlog','repository.write','github:repo',$5,'ALLOW',
           'ACTION_ALLOWED','The action is allowed.',NULL,clock_timestamp(),$6)`,
        [tenantId, environment, decisionId, mandateId, JSON.stringify({}), `req_${decisionId}`]
      );
    }
    await pool.query(
      `INSERT INTO mandate.action_attempts
        (tenant_id, environment, id, decision_id, mandate_id, agent_id, action, resource, status,
         reserved_by_credential_id, reserved_at, expires_at, request_id, version,
         terminated_at, termination_reason, termination_request_id)
       VALUES
        ($1,$2,$3,$4,$5,'agent_backlog','repository.write','github:repo','RESERVED',$6,
         clock_timestamp() - interval '10 minutes',clock_timestamp() - interval '90 seconds','req_due',0,NULL,NULL,NULL),
        ($1,$2,$7,$8,$5,'agent_backlog','repository.write','github:repo','RESERVED',$6,
         clock_timestamp(),clock_timestamp() + interval '1 hour','req_future',0,NULL,NULL,NULL),
        ($1,$2,$9,$10,$5,'agent_backlog','repository.write','github:repo','EXPIRED',$6,
         clock_timestamp() - interval '3 hours',clock_timestamp() - interval '2 hours','req_terminal',1,
         clock_timestamp() - interval '2 hours','RESERVATION_EXPIRED','sys_terminal')`,
      [tenantId, environment, attemptIds[0], decisionIds[0], mandateId, credentialId,
        attemptIds[1], decisionIds[1], attemptIds[2], decisionIds[2]]
    );

    const backlog = await inspectActionAttemptExpiryBacklog(
      store,
      { tenantId, environment },
      { now: new Date('2000-01-01T00:00:00.000Z') }
    );
    assert.equal(backlog.reservedCount, 2);
    assert.equal(backlog.dueCount, 1);
    assert.match(backlog.oldestDueAt, /^20\d\d-/);
    assert.ok(backlog.oldestOverdueSeconds >= 89);
    assert.ok(Date.parse(backlog.observedAt) > Date.parse('2026-01-01T00:00:00.000Z'));
  } finally {
    await store.close();
  }
});
