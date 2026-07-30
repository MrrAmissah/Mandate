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

function quoteServerIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function tablePrivilege(client, role, table, action) {
  const result = await client.query(
    'SELECT has_table_privilege($1, $2, $3) AS allowed',
    [role, table, action]
  );
  return result.rows[0].allowed;
}

async function databasePrivilege(client, role, database, action) {
  const result = await client.query(
    'SELECT has_database_privilege($1, $2, $3) AS allowed',
    [role, database, action]
  );
  return result.rows[0].allowed;
}

async function schemaPrivilege(client, role, schema, action) {
  const result = await client.query(
    'SELECT has_schema_privilege($1, $2, $3) AS allowed',
    [role, schema, action]
  );
  return result.rows[0].allowed;
}

postgresTest('database role policy removes inherited, current and future runtime DDL authority', async (t) => {
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
  const customSchema = `mdt_schema_${suffix}`;
  const futureTable = `future_table_${suffix}`;
  const futureSequence = `future_sequence_${suffix}`;
  const futureFunction = `future_function_${suffix}`;
  const allRoles = [...Object.values(roles), parentRole];
  const client = await pool.connect();
  let databaseName;
  try {
    const authority = await client.query(
      'SELECT rolsuper OR rolcreaterole AS can_manage_roles, current_database() AS database_name FROM pg_roles WHERE rolname = current_user'
    );
    if (!authority.rows[0]?.can_manage_roles) {
      t.skip('PostgreSQL test user cannot create disposable roles.');
      return;
    }
    databaseName = authority.rows[0].database_name;

    await applyMigrations(pool, { logger: { log() {} } });
    for (const role of allRoles) {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
      );
    }
    await client.query(`CREATE SCHEMA ${quoteIdentifier(customSchema)}`);

    await client.query(`GRANT CREATE ON DATABASE ${quoteServerIdentifier(databaseName)} TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT TEMPORARY ON DATABASE ${quoteServerIdentifier(databaseName)} TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT CREATE ON SCHEMA ${quoteIdentifier(customSchema)} TO PUBLIC`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA mandate GRANT SELECT ON TABLES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA mandate GRANT USAGE ON SEQUENCES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA mandate GRANT EXECUTE ON FUNCTIONS TO ${quoteIdentifier(roles.api)}`);

    await client.query(`GRANT ${quoteIdentifier(parentRole)} TO ${quoteIdentifier(roles.api)}`);
    await assert.rejects(
      applyDatabaseRolePolicy(client, { roles }),
      /inherits another role/
    );
    await client.query(`REVOKE ${quoteIdentifier(parentRole)} FROM ${quoteIdentifier(roles.api)}`);

    const result = await applyDatabaseRolePolicy(client, { roles });
    assert.equal(result.roles.api, roles.api);
    assert.equal(result.policyVersion, '2026-07-30.4');
    assert.ok(result.schemaNames.includes('mandate'));
    assert.ok(result.schemaNames.includes('public'));
    assert.ok(result.schemaNames.includes(customSchema));

    assert.equal(await tablePrivilege(client, roles.api, 'mandate.mandates', 'SELECT'), true);
    assert.equal(await tablePrivilege(client, roles.api, 'mandate.mandates', 'INSERT'), true);
    assert.equal(await tablePrivilege(client, roles.api, 'mandate.mandates', 'DELETE'), false);
    assert.equal(await tablePrivilege(client, roles.api, 'mandate.outbox_dead_letter_replays', 'INSERT'), false);

    assert.equal(await tablePrivilege(client, roles.expiry, 'mandate.action_attempts', 'UPDATE'), true);
    assert.equal(await tablePrivilege(client, roles.expiry, 'mandate.action_attempts', 'INSERT'), false);
    assert.equal(await tablePrivilege(client, roles.expiry, 'mandate.outbox_attempts', 'INSERT'), false);

    assert.equal(await tablePrivilege(client, roles.outbox, 'mandate.outbox_messages', 'UPDATE'), true);
    assert.equal(await tablePrivilege(client, roles.outbox, 'mandate.outbox_attempts', 'INSERT'), true);
    assert.equal(await tablePrivilege(client, roles.outbox, 'mandate.receipts', 'SELECT'), false);

    assert.equal(await tablePrivilege(client, roles.maintenance, 'mandate.idempotency_records', 'DELETE'), true);
    assert.equal(await tablePrivilege(client, roles.maintenance, 'mandate.idempotency_records', 'UPDATE'), false);
    assert.equal(await tablePrivilege(client, roles.maintenance, 'mandate.outbox_messages', 'SELECT'), false);

    assert.equal(await tablePrivilege(client, roles.operator, 'mandate.outbox_dead_letter_replays', 'INSERT'), true);
    assert.equal(await tablePrivilege(client, roles.operator, 'mandate.outbox_messages', 'UPDATE'), true);
    assert.equal(await tablePrivilege(client, roles.operator, 'mandate.idempotency_records', 'DELETE'), false);

    assert.equal(await databasePrivilege(client, roles.api, databaseName, 'CONNECT'), true);
    assert.equal(await databasePrivilege(client, roles.api, databaseName, 'CREATE'), false);
    assert.equal(await databasePrivilege(client, roles.api, databaseName, 'TEMPORARY'), false);
    assert.equal(await schemaPrivilege(client, roles.api, 'mandate', 'CREATE'), false);
    assert.equal(await schemaPrivilege(client, roles.api, 'public', 'CREATE'), false);
    assert.equal(await schemaPrivilege(client, roles.api, customSchema, 'CREATE'), false);

    await client.query(`CREATE TABLE mandate.${quoteIdentifier(futureTable)} (id integer)`);
    await client.query(`CREATE SEQUENCE mandate.${quoteIdentifier(futureSequence)}`);
    await client.query(`CREATE FUNCTION mandate.${quoteIdentifier(futureFunction)}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    assert.equal(await tablePrivilege(client, roles.api, `mandate.${futureTable}`, 'SELECT'), false);
    const sequence = await client.query(
      'SELECT has_sequence_privilege($1, $2, \'USAGE\') AS allowed',
      [roles.api, `mandate.${futureSequence}`]
    );
    assert.equal(sequence.rows[0].allowed, false);
    const fn = await client.query(
      'SELECT has_function_privilege($1, $2, \'EXECUTE\') AS allowed',
      [roles.api, `mandate.${futureFunction}()`]
    );
    assert.equal(fn.rows[0].allowed, false);
  } finally {
    await client.query(`DROP FUNCTION IF EXISTS mandate.${quoteIdentifier(futureFunction)}()`).catch(() => {});
    await client.query(`DROP SEQUENCE IF EXISTS mandate.${quoteIdentifier(futureSequence)}`).catch(() => {});
    await client.query(`DROP TABLE IF EXISTS mandate.${quoteIdentifier(futureTable)}`).catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(customSchema)} CASCADE`).catch(() => {});
    for (const role of allRoles.reverse()) {
      await client.query(`DROP OWNED BY ${quoteIdentifier(role)}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => {});
    }
    client.release();
    await pool.end();
  }
});
