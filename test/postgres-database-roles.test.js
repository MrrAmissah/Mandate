import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import {
  applyDatabaseRolePolicy,
  parseDatabaseRolePolicyConfig
} from '../src/deployment/database-role-policy.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Unsafe test role identifier.');
  return `"${value}"`;
}

async function privilege(client, role, table, action) {
  const result = await client.query(
    'SELECT has_table_privilege($1, $2, $3) AS allowed',
    [role, `mandate.${table}`, action]
  );
  return result.rows[0].allowed;
}

postgresTest('database role policy is least-privilege and rejects inherited authority', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const roles = {
    api: `mdt_api_${suffix}`,
    expiry: `mdt_exp_${suffix}`,
    outbox: `mdt_out_${suffix}`,
    maintenance: `mdt_mnt_${suffix}`,
    operator: `mdt_opr_${suffix}`
  };
  const parentRole = `mdt_parent_${suffix}`;
  const allRoles = [...Object.values(roles), parentRole];
  const client = await pool.connect();
  try {
    const authority = await client.query(
      'SELECT rolsuper OR rolcreaterole AS can_manage_roles FROM pg_roles WHERE rolname = current_user'
    );
    if (!authority.rows[0]?.can_manage_roles) {
      t.skip('PostgreSQL test user cannot create disposable roles.');
      return;
    }

    await applyMigrations(pool, { logger: { log() {} } });
    for (const role of allRoles) {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
      );
    }

    await client.query(`GRANT ${quoteIdentifier(parentRole)} TO ${quoteIdentifier(roles.api)}`);
    await assert.rejects(
      applyDatabaseRolePolicy(client, { roles }),
      /inherits another role/
    );
    await client.query(`REVOKE ${quoteIdentifier(parentRole)} FROM ${quoteIdentifier(roles.api)}`);

    const result = await applyDatabaseRolePolicy(client, { roles });
    assert.equal(result.roles.api, roles.api);
    assert.equal(result.policyVersion, '2026-07-30.1');

    assert.equal(await privilege(client, roles.api, 'mandates', 'SELECT'), true);
    assert.equal(await privilege(client, roles.api, 'mandates', 'INSERT'), true);
    assert.equal(await privilege(client, roles.api, 'mandates', 'DELETE'), false);
    assert.equal(await privilege(client, roles.api, 'outbox_dead_letter_replays', 'INSERT'), false);

    assert.equal(await privilege(client, roles.expiry, 'action_attempts', 'UPDATE'), true);
    assert.equal(await privilege(client, roles.expiry, 'action_attempts', 'INSERT'), false);
    assert.equal(await privilege(client, roles.expiry, 'outbox_attempts', 'INSERT'), false);

    assert.equal(await privilege(client, roles.outbox, 'outbox_messages', 'UPDATE'), true);
    assert.equal(await privilege(client, roles.outbox, 'outbox_attempts', 'INSERT'), true);
    assert.equal(await privilege(client, roles.outbox, 'receipts', 'SELECT'), false);

    assert.equal(await privilege(client, roles.maintenance, 'idempotency_records', 'DELETE'), true);
    assert.equal(await privilege(client, roles.maintenance, 'idempotency_records', 'UPDATE'), false);
    assert.equal(await privilege(client, roles.maintenance, 'outbox_messages', 'SELECT'), false);

    assert.equal(await privilege(client, roles.operator, 'outbox_dead_letter_replays', 'INSERT'), true);
    assert.equal(await privilege(client, roles.operator, 'outbox_messages', 'UPDATE'), true);
    assert.equal(await privilege(client, roles.operator, 'idempotency_records', 'DELETE'), false);

    const connection = await client.query(
      'SELECT has_database_privilege(current_user, current_database(), \'CONNECT\') AS allowed'
    );
    assert.equal(connection.rows[0].allowed, true);
  } finally {
    for (const role of allRoles.reverse()) {
      await client.query(`DROP OWNED BY ${quoteIdentifier(role)}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => {});
    }
    client.release();
    await pool.end();
  }
});
