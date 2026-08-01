import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { applyMigrations } from '../src/store/postgres-migrations.js';
import { applyDatabaseRolePolicy } from '../src/deployment/database-role-policy.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Unsafe test role identifier.');
  return `"${value}"`;
}

function quoteServerIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

postgresTest('database role policy removes database CREATE inherited through PUBLIC', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const roles = {
    api: `mdt_pca_${suffix}`,
    expiry: `mdt_pce_${suffix}`,
    outbox: `mdt_pco_${suffix}`,
    maintenance: `mdt_pcm_${suffix}`,
    operator: `mdt_pcp_${suffix}`
  };
  const roleNames = Object.values(roles);
  let databaseName;

  try {
    const authority = await client.query(
      `SELECT rolsuper, current_database() AS database_name
         FROM pg_roles
        WHERE rolname = current_user`
    );
    if (!authority.rows[0]?.rolsuper) {
      t.skip('PostgreSQL test user must be a superuser for disposable-role and database-ACL proof.');
      return;
    }
    databaseName = authority.rows[0].database_name;

    await applyMigrations(pool, { logger: { log() {} } });
    for (const roleName of roleNames) {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(roleName)} NOLOGIN
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
      );
    }

    await client.query(`GRANT CREATE ON DATABASE ${quoteServerIdentifier(databaseName)} TO PUBLIC`);
    for (const roleName of roleNames) {
      const seeded = await client.query(
        'SELECT has_database_privilege($1, $2, $3) AS allowed',
        [roleName, databaseName, 'CREATE']
      );
      assert.equal(seeded.rows[0].allowed, true);
    }

    const result = await applyDatabaseRolePolicy(client, { roles });
    assert.equal(result.policyVersion, '2026-07-30.9');

    const publicPrivilege = await client.query(
      'SELECT has_database_privilege($1, $2, $3) AS allowed',
      ['public', databaseName, 'CREATE']
    );
    assert.equal(publicPrivilege.rows[0].allowed, false);

    for (const roleName of roleNames) {
      const effectivePrivilege = await client.query(
        'SELECT has_database_privilege($1, $2, $3) AS allowed',
        [roleName, databaseName, 'CREATE']
      );
      assert.equal(effectivePrivilege.rows[0].allowed, false);
    }
  } finally {
    if (databaseName) {
      await client.query(`REVOKE CREATE ON DATABASE ${quoteServerIdentifier(databaseName)} FROM PUBLIC`).catch(() => {});
    }
    for (const roleName of roleNames.reverse()) {
      await client.query(`DROP OWNED BY ${quoteIdentifier(roleName)}`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)}`).catch(() => {});
    }
    client.release();
    await pool.end();
  }
});
