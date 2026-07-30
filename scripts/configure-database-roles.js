import { Pool } from 'pg';
import {
  applyDatabaseRolePolicy,
  parseDatabaseRolePolicyConfig
} from '../src/deployment/database-role-policy.js';

function booleanValue(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('MANDATE_DATABASE_SSL must be true or false.');
}

async function main(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for database role configuration.');
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    ssl: booleanValue(env.MANDATE_DATABASE_SSL, false) ? { rejectUnauthorized: true } : false
  });
  const client = await pool.connect();
  try {
    const result = await applyDatabaseRolePolicy(client, parseDatabaseRolePolicyConfig(env));
    console.log(JSON.stringify({
      event: 'database_roles.configured',
      at: new Date().toISOString(),
      policyVersion: result.policyVersion,
      databaseName: result.databaseName,
      roles: result.roles,
      statementCount: result.statementCount
    }));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'database_roles.configuration_failed',
    at: new Date().toISOString(),
    errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code
      : 'DATABASE_ROLE_CONFIGURATION_FAILED'
  }));
  process.exitCode = 1;
});
