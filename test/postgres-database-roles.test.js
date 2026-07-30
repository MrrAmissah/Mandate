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

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function roleConnectionString(connectionString, role, password) {
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function tablePrivilege(client, role, table, action) {
  const result = await client.query(
    'SELECT has_table_privilege($1, $2, $3) AS allowed',
    [role, table, action]
  );
  return result.rows[0].allowed;
}

async function columnPrivilege(client, role, table, column, action) {
  const result = await client.query(
    'SELECT has_column_privilege($1, $2, $3, $4) AS allowed',
    [role, table, column, action]
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

async function sequencePrivilege(client, role, sequence, action) {
  const result = await client.query(
    'SELECT has_sequence_privilege($1, $2, $3) AS allowed',
    [role, sequence, action]
  );
  return result.rows[0].allowed;
}

async function routinePrivilege(client, role, routine, action = 'EXECUTE') {
  const result = await client.query(
    'SELECT has_function_privilege($1, $2, $3) AS allowed',
    [role, routine, action]
  );
  return result.rows[0].allowed;
}

postgresTest('database role policy quiesces sessions and removes current, future and ownership authority', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const roles = {
    api: `mdt_api_${suffix}`,
    expiry: `mdt_exp_${suffix}`,
    outbox: `mdt_out_${suffix}`,
    maintenance: `mdt_mnt_${suffix}`,
    operator: `mdt_opr_${suffix}`
  };
  const apiPassword = `MdtApi${suffix}A1`;
  const parentRole = `mdt_parent_${suffix}`;
  const customSchema = `mdt_schema_${suffix}`;
  const existingTable = `existing_table_${suffix}`;
  const existingSequence = `existing_sequence_${suffix}`;
  const existingFunction = `existing_function_${suffix}`;
  const existingProcedure = `existing_procedure_${suffix}`;
  const mandateProcedure = `mandate_procedure_${suffix}`;
  const ownedType = `owned_type_${suffix}`;
  const futureTable = `future_table_${suffix}`;
  const futureSequence = `future_sequence_${suffix}`;
  const futureFunction = `future_function_${suffix}`;
  const futureProcedure = `future_procedure_${suffix}`;
  const customFutureTable = `custom_future_table_${suffix}`;
  const customFutureFunction = `custom_future_function_${suffix}`;
  const allRoles = [...Object.values(roles), parentRole];
  const client = await pool.connect();
  let runtimePool;
  let runtimeClient;
  let databaseName;
  let deploymentRoleName;
  try {
    const authority = await client.query(
      `SELECT rolsuper,
              rolsuper OR rolcreaterole AS can_manage_roles,
              current_database() AS database_name,
              current_user AS deployment_role_name
         FROM pg_roles
        WHERE rolname = current_user`
    );
    if (!authority.rows[0]?.rolsuper || !authority.rows[0]?.can_manage_roles) {
      t.skip('PostgreSQL test user must be a superuser for session-quiescence and disposable-role proof.');
      return;
    }
    databaseName = authority.rows[0].database_name;
    deploymentRoleName = authority.rows[0].deployment_role_name;

    await applyMigrations(pool, { logger: { log() {} } });
    await client.query(
      `CREATE ROLE ${quoteIdentifier(roles.api)} LOGIN PASSWORD ${quoteLiteral(apiPassword)}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    for (const role of [...Object.values(roles).slice(1), parentRole]) {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
      );
    }

    await client.query(`CREATE SCHEMA ${quoteIdentifier(customSchema)}`);
    await client.query(`CREATE TABLE ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingTable)} (id integer, payload text)`);
    await client.query(`CREATE SEQUENCE ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingSequence)}`);
    await client.query(
      `CREATE FUNCTION ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingFunction)}()
       RETURNS integer LANGUAGE sql AS 'SELECT 1'`
    );
    await client.query(
      `CREATE PROCEDURE ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingProcedure)}()
       LANGUAGE plpgsql AS 'BEGIN NULL; END;'`
    );
    await client.query(
      `CREATE PROCEDURE mandate.${quoteIdentifier(mandateProcedure)}()
       LANGUAGE plpgsql AS 'BEGIN NULL; END;'`
    );
    await client.query(
      `CREATE TYPE ${quoteIdentifier(customSchema)}.${quoteIdentifier(ownedType)} AS ENUM ('one', 'two')`
    );

    await client.query(`GRANT CONNECT ON DATABASE ${quoteServerIdentifier(databaseName)} TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT CREATE ON DATABASE ${quoteServerIdentifier(databaseName)} TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT TEMPORARY ON DATABASE ${quoteServerIdentifier(databaseName)} TO ${quoteIdentifier(roles.api)}`);
    await client.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    await client.query(`GRANT CREATE, USAGE ON SCHEMA ${quoteIdentifier(customSchema)} TO PUBLIC`);
    await client.query(`GRANT SELECT ON ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingTable)} TO PUBLIC`);
    await client.query(`GRANT UPDATE (payload) ON ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingTable)} TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT USAGE ON SEQUENCE ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingSequence)} TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT EXECUTE ON FUNCTION ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingFunction)}() TO ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT EXECUTE ON PROCEDURE ${quoteIdentifier(customSchema)}.${quoteIdentifier(existingProcedure)}() TO PUBLIC`);
    await client.query(`GRANT EXECUTE ON PROCEDURE mandate.${quoteIdentifier(mandateProcedure)}() TO ${quoteIdentifier(roles.api)}`);
    await client.query('GRANT SELECT (id) ON mandate.outbox_dead_letter_replays TO PUBLIC');
    await client.query(`GRANT UPDATE (error_code) ON mandate.outbox_attempts TO ${quoteIdentifier(roles.api)}`);

    await client.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON ROUTINES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA mandate GRANT SELECT ON TABLES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA mandate GRANT USAGE ON SEQUENCES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA mandate GRANT EXECUTE ON ROUTINES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(customSchema)} GRANT SELECT ON TABLES TO ${quoteIdentifier(roles.api)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(customSchema)} GRANT EXECUTE ON ROUTINES TO ${quoteIdentifier(roles.api)}`);

    runtimePool = new Pool({
      connectionString: roleConnectionString(databaseUrl, roles.api, apiPassword),
      max: 1
    });
    runtimeClient = await runtimePool.connect();
    runtimeClient.on('error', () => {});
    await runtimeClient.query('SELECT 1');

    await client.query(`GRANT ${quoteIdentifier(parentRole)} TO ${quoteIdentifier(roles.api)}`);
    await assert.rejects(
      applyDatabaseRolePolicy(client, { roles }),
      /participates in role inheritance/
    );
    await client.query(`REVOKE ${quoteIdentifier(parentRole)} FROM ${quoteIdentifier(roles.api)}`);
    await client.query(`GRANT ${quoteIdentifier(roles.api)} TO ${quoteIdentifier(parentRole)}`);
    await assert.rejects(
      applyDatabaseRolePolicy(client, { roles }),
      /participates in role inheritance/
    );
    await client.query(`REVOKE ${quoteIdentifier(roles.api)} FROM ${quoteIdentifier(parentRole)}`);

    await client.query(
      `ALTER TYPE ${quoteIdentifier(customSchema)}.${quoteIdentifier(ownedType)} OWNER TO ${quoteIdentifier(roles.api)}`
    );
    await assert.rejects(
      applyDatabaseRolePolicy(client, { roles }),
      /owns a protected object/
    );
    await client.query(
      `ALTER TYPE ${quoteIdentifier(customSchema)}.${quoteIdentifier(ownedType)} OWNER TO ${quoteServerIdentifier(deploymentRoleName)}`
    );

    const result = await applyDatabaseRolePolicy(client, { roles });
    assert.equal(result.roles.api, roles.api);
    assert.equal(result.policyVersion, '2026-07-30.8');
    assert.ok(result.schemaNames.includes('mandate'));
    assert.ok(result.schemaNames.includes('public'));
    assert.ok(result.schemaNames.includes(customSchema));
    assert.ok(result.tableCount > 0);
    assert.ok(result.terminatedSessionCount >= 1);

    await assert.rejects(runtimeClient.query('SELECT 1'));
    runtimeClient.release(true);
    runtimeClient = null;
    await runtimePool.end();
    runtimePool = null;

    assert.equal(await tablePrivilege(client, roles.api, 'mandate.mandates', 'SELECT'), true);
    assert.equal(await tablePrivilege(client, roles.api, 'mandate.mandates', 'INSERT'), true);
    assert.equal(await tablePrivilege(client, roles.api, 'mandate.mandates', 'DELETE'), false);
    assert.equal(await tablePrivilege(client, roles.api, 'mandate.outbox_dead_letter_replays', 'INSERT'), false);
    assert.equal(
      await columnPrivilege(client, roles.api, 'mandate.outbox_dead_letter_replays', 'id', 'SELECT'),
      false
    );
    assert.equal(
      await columnPrivilege(client, roles.api, 'mandate.outbox_attempts', 'error_code', 'UPDATE'),
      false
    );

    assert.equal(await tablePrivilege(client, roles.expiry, 'mandate.action_attempts', 'UPDATE'), true);
    assert.equal(await tablePrivilege(client, roles.expiry, 'mandate.action_attempts', 'INSERT'), false);
    assert.equal(await tablePrivilege(client, roles.expiry, 'mandate.outbox_attempts', 'INSERT'), false);
    assert.equal(await tablePrivilege(client, roles.outbox, 'mandate.outbox_messages', 'UPDATE'), true);
    assert.equal(await tablePrivilege(client, roles.outbox, 'mandate.outbox_attempts', 'INSERT'), true);
    assert.equal(await tablePrivilege(client, roles.outbox, 'mandate.receipts', 'SELECT'), false);
    assert.equal(await tablePrivilege(client, roles.maintenance, 'mandate.idempotency_records', 'DELETE'), true);
    assert.equal(await tablePrivilege(client, roles.maintenance, 'mandate.idempotency_records', 'UPDATE'), false);
    assert.equal(await tablePrivilege(client, roles.operator, 'mandate.outbox_dead_letter_replays', 'INSERT'), true);
    assert.equal(await tablePrivilege(client, roles.operator, 'mandate.idempotency_records', 'DELETE'), false);

    assert.equal(await databasePrivilege(client, roles.api, databaseName, 'CONNECT'), true);
    assert.equal(await databasePrivilege(client, roles.api, databaseName, 'CREATE'), false);
    assert.equal(await databasePrivilege(client, roles.api, databaseName, 'TEMPORARY'), false);
    assert.equal(await schemaPrivilege(client, roles.api, 'mandate', 'USAGE'), true);
    assert.equal(await schemaPrivilege(client, roles.api, 'mandate', 'CREATE'), false);
    assert.equal(await schemaPrivilege(client, roles.api, 'public', 'USAGE'), false);
    assert.equal(await schemaPrivilege(client, roles.api, customSchema, 'USAGE'), false);
    assert.equal(await tablePrivilege(client, roles.api, `${customSchema}.${existingTable}`, 'SELECT'), false);
    assert.equal(await columnPrivilege(client, roles.api, `${customSchema}.${existingTable}`, 'payload', 'UPDATE'), false);
    assert.equal(await sequencePrivilege(client, roles.api, `${customSchema}.${existingSequence}`, 'USAGE'), false);
    assert.equal(await routinePrivilege(client, roles.api, `${customSchema}.${existingFunction}()`), false);
    assert.equal(await routinePrivilege(client, roles.api, `${customSchema}.${existingProcedure}()`), false);
    assert.equal(await routinePrivilege(client, roles.api, `mandate.${mandateProcedure}()`), false);

    runtimePool = new Pool({
      connectionString: roleConnectionString(databaseUrl, roles.api, apiPassword),
      max: 1
    });
    runtimeClient = await runtimePool.connect();
    await runtimeClient.query('SELECT 1');
    await assert.rejects(runtimeClient.query('CREATE TEMP TABLE should_be_denied (id integer)'), /permission denied/);
    await assert.rejects(runtimeClient.query(`CREATE SCHEMA ${quoteIdentifier(`denied_${suffix}`)}`), /permission denied/);
    await assert.rejects(
      runtimeClient.query(`CREATE TABLE ${quoteIdentifier(customSchema)}.${quoteIdentifier(`denied_${suffix}`)} (id integer)`),
      /permission denied/
    );
    await assert.rejects(
      runtimeClient.query(`CALL mandate.${quoteIdentifier(mandateProcedure)}()`),
      /permission denied/
    );
    runtimeClient.release();
    runtimeClient = null;
    await runtimePool.end();
    runtimePool = null;

    await client.query(`CREATE TABLE mandate.${quoteIdentifier(futureTable)} (id integer)`);
    await client.query(`CREATE SEQUENCE mandate.${quoteIdentifier(futureSequence)}`);
    await client.query(
      `CREATE FUNCTION mandate.${quoteIdentifier(futureFunction)}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`
    );
    await client.query(
      `CREATE PROCEDURE mandate.${quoteIdentifier(futureProcedure)}() LANGUAGE plpgsql AS 'BEGIN NULL; END;'`
    );
    await client.query(`CREATE TABLE ${quoteIdentifier(customSchema)}.${quoteIdentifier(customFutureTable)} (id integer)`);
    await client.query(
      `CREATE FUNCTION ${quoteIdentifier(customSchema)}.${quoteIdentifier(customFutureFunction)}()
       RETURNS integer LANGUAGE sql AS 'SELECT 1'`
    );

    assert.equal(await tablePrivilege(client, roles.api, `mandate.${futureTable}`, 'SELECT'), false);
    assert.equal(await sequencePrivilege(client, roles.api, `mandate.${futureSequence}`, 'USAGE'), false);
    assert.equal(await routinePrivilege(client, roles.api, `mandate.${futureFunction}()`), false);
    assert.equal(await routinePrivilege(client, roles.api, `mandate.${futureProcedure}()`), false);
    assert.equal(await tablePrivilege(client, roles.api, `${customSchema}.${customFutureTable}`, 'SELECT'), false);
    assert.equal(await routinePrivilege(client, roles.api, `${customSchema}.${customFutureFunction}()`), false);
  } finally {
    if (runtimeClient) runtimeClient.release(true);
    if (runtimePool) await runtimePool.end().catch(() => {});
    await client.query(`DROP PROCEDURE IF EXISTS mandate.${quoteIdentifier(futureProcedure)}()`).catch(() => {});
    await client.query(`DROP FUNCTION IF EXISTS mandate.${quoteIdentifier(futureFunction)}()`).catch(() => {});
    await client.query(`DROP SEQUENCE IF EXISTS mandate.${quoteIdentifier(futureSequence)}`).catch(() => {});
    await client.query(`DROP TABLE IF EXISTS mandate.${quoteIdentifier(futureTable)}`).catch(() => {});
    await client.query(`DROP PROCEDURE IF EXISTS mandate.${quoteIdentifier(mandateProcedure)}()`).catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(customSchema)} CASCADE`).catch(() => {});
    for (const role of allRoles.reverse()) {
      await client.query(`DROP OWNED BY ${quoteIdentifier(role)}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`).catch(() => {});
    }
    client.release();
    await pool.end();
  }
});