import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildDatabaseRolePolicyStatements,
  databaseRolePolicy,
  parseDatabaseRolePolicyConfig
} from '../src/deployment/database-role-policy.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('production image runs as a fixed non-root user with the secret entrypoint', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /node:22\.23\.1-bookworm-slim/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/mandate-entrypoint"\]/);
  assert.doesNotMatch(dockerfile, /COPY .*\.env/);
});

test('container entrypoint loads only the supported secret-file variables', async () => {
  const entrypoint = await read('deployment/container-entrypoint.sh');
  for (const name of ['DATABASE_URL', 'MANDATE_API_KEY', 'MANDATE_PRIVATE_KEY_PEM', 'MANDATE_PUBLIC_KEY_PEM']) {
    assert.match(entrypoint, new RegExp(`load_secret ${name}`));
  }
  assert.match(entrypoint, /Both \$name and \$file_name are set/);
  assert.match(entrypoint, /MAX_SECRET_BYTES=1048576/);
  assert.match(entrypoint, /exec "\$@"/);
});

test('production compose separates migration, API, expiry and outbox identities', async () => {
  const compose = await read('deployment/compose.production.yaml');
  for (const service of ['migrate:', 'configure-database-roles:', 'api:', 'attempt-expiry:', 'outbox:']) {
    assert.match(compose, new RegExp(`\\n  ${service.replace(':', '\\:')}`));
  }
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n    - ALL/);
  assert.match(compose, /MANDATE_API_KEY_FILE: \/run\/secrets\/api_key/);
  assert.match(compose, /MANDATE_API_READINESS_TIMEOUT_MS/);
  assert.match(compose, /127\.0\.0\.1:8787\/health\/ready/);
  assert.match(compose, /MANDATE_OUTBOX_HANDLER_FILE:\?Set MANDATE_OUTBOX_HANDLER_FILE/);
  const expiryBlock = compose.split('\n  attempt-expiry:')[1].split('\n  outbox:')[0];
  const outboxBlock = compose.split('\n  outbox:')[1].split('\nnetworks:')[0];
  assert.doesNotMatch(expiryBlock, /MANDATE_API_KEY/);
  assert.doesNotMatch(outboxBlock, /MANDATE_API_KEY/);
});

test('database roles are distinct and identifiers fail closed', () => {
  const config = parseDatabaseRolePolicyConfig({});
  assert.equal(new Set(Object.values(config.roles)).size, 5);
  assert.throws(
    () => parseDatabaseRolePolicyConfig({ MANDATE_DATABASE_API_ROLE: 'unsafe-role' }),
    /Unsafe PostgreSQL role identifier/
  );
  assert.throws(
    () => parseDatabaseRolePolicyConfig({ MANDATE_DATABASE_API_ROLE: 'same', MANDATE_DATABASE_EXPIRY_ROLE: 'same' }),
    /distinct name/
  );
});

test('managed database, deployment-role and schema identifiers are quoted safely', () => {
  const roles = parseDatabaseRolePolicyConfig({}).roles;
  const statements = buildDatabaseRolePolicyStatements({
    roles,
    databaseName: 'Mandate-Prod.EU',
    deploymentRoleName: 'migration-user"blue',
    schemaNames: ['mandate', 'public', 'Partner-Data']
  });
  const joined = statements.join('\n');
  assert.match(joined, /REVOKE CONNECT ON DATABASE "Mandate-Prod\.EU" FROM PUBLIC/);
  assert.match(joined, /REVOKE TEMPORARY ON DATABASE "Mandate-Prod\.EU" FROM PUBLIC/);
  assert.match(joined, /GRANT CONNECT ON DATABASE "Mandate-Prod\.EU" TO "migration-user""blue"/);
  assert.match(joined, /REVOKE CREATE ON SCHEMA "Partner-Data" FROM PUBLIC/);
  assert.throws(
    () => buildDatabaseRolePolicyStatements({
      roles,
      databaseName: `bad\0database`,
      deploymentRoleName: 'migration-user'
    }),
    /database identifier is unavailable or invalid/
  );
});

test('runtime role policy removes database, schema and future-object DDL authority', () => {
  const roles = parseDatabaseRolePolicyConfig({}).roles;
  const statements = buildDatabaseRolePolicyStatements({
    roles,
    databaseName: 'mandate',
    deploymentRoleName: 'mandate_migrator',
    schemaNames: ['mandate', 'public']
  });
  const joined = statements.join('\n');
  assert.match(joined, /REVOKE ALL ON SCHEMA mandate FROM PUBLIC/);
  assert.match(joined, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mandate FROM PUBLIC/);
  assert.match(joined, /REVOKE CREATE ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(joined, /REVOKE TEMPORARY ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(joined, /REVOKE CREATE ON SCHEMA "public" FROM "mandate_api"/);
  assert.match(joined, /ALTER DEFAULT PRIVILEGES FOR ROLE "mandate_migrator" IN SCHEMA mandate REVOKE ALL ON TABLES FROM "mandate_api"/);
  assert.match(joined, /GRANT SELECT, DELETE ON TABLE mandate\.idempotency_records TO "mandate_maintenance"/);
  assert.doesNotMatch(joined, /GRANT EXECUTE/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_api"/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_expiry_worker"/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_outbox_worker"/);
  assert.doesNotMatch(joined, /GRANT [^;]*CREATE[^;]*TO "mandate_/);
  assert.equal(databaseRolePolicy.requiredMigration, '010_outbox_dead_letter_replays');
  assert.deepEqual(databaseRolePolicy.functionRoles, []);
});

test('worker and operator table privileges remain narrowly separated', () => {
  const grants = databaseRolePolicy.tableGrants;
  assert.deepEqual(grants.outbox.outbox_messages, ['SELECT', 'UPDATE']);
  assert.deepEqual(grants.outbox.outbox_attempts, ['SELECT', 'INSERT']);
  assert.equal(grants.outbox.receipts, undefined);
  assert.deepEqual(grants.expiry.action_attempts, ['SELECT', 'UPDATE']);
  assert.equal(grants.expiry.outbox_attempts, undefined);
  assert.deepEqual(grants.operator.outbox_dead_letter_replays, ['SELECT', 'INSERT']);
  assert.equal(grants.operator.idempotency_records, undefined);
});
