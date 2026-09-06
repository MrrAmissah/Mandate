import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildDatabaseRolePolicyStatements,
  buildDatabaseRoleQuiesceStatements,
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
  for (const name of [
    'DATABASE_URL',
    'MANDATE_RECOVERY_TARGET_URL',
    'MANDATE_API_KEY',
    'MANDATE_PRIVATE_KEY_PEM',
    'MANDATE_PUBLIC_KEY_PEM'
  ]) {
    assert.match(entrypoint, new RegExp(`load_secret ${name}`));
  }
  assert.match(entrypoint, /Both \$name and \$file_name are set/);
  assert.match(entrypoint, /MAX_SECRET_BYTES=1048576/);
  assert.match(entrypoint, /exec "\$@"/);
});

test('production compose separates migration, API, both expiry workers and outbox identities', async () => {
  const compose = await read('deployment/compose.production.yaml');
  for (const service of [
    'migrate:',
    'configure-database-roles:',
    'api:',
    'attempt-expiry:',
    'approval-expiry:',
    'outbox:'
  ]) {
    assert.match(compose, new RegExp(`\\n  ${service.replace(':', '\\:')}`));
  }
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n    - ALL/);
  assert.match(compose, /MANDATE_API_KEY_FILE: \/run\/secrets\/api_key/);
  assert.match(compose, /MANDATE_API_READINESS_TIMEOUT_MS/);
  assert.match(compose, /127\.0\.0\.1:8787\/health\/ready/);
  assert.match(compose, /MANDATE_OUTBOX_HANDLER_FILE:\?Set MANDATE_OUTBOX_HANDLER_FILE/);
  assert.match(compose, /MANDATE_DATABASE_APPROVAL_EXPIRY_ROLE: \$\{MANDATE_DATABASE_APPROVAL_EXPIRY_ROLE:-mandate_approval_expiry_worker\}/);
  assert.match(compose, /MANDATE_APPROVAL_EXPIRY_DATABASE_URL_FILE:\?Set MANDATE_APPROVAL_EXPIRY_DATABASE_URL_FILE/);

  const attemptExpiryBlock = compose.split('\n  attempt-expiry:')[1].split('\n  approval-expiry:')[0];
  const approvalExpiryBlock = compose.split('\n  approval-expiry:')[1].split('\n  outbox:')[0];
  const outboxBlock = compose.split('\n  outbox:')[1].split('\nnetworks:')[0];
  assert.doesNotMatch(attemptExpiryBlock, /MANDATE_API_KEY/);
  assert.doesNotMatch(approvalExpiryBlock, /MANDATE_API_KEY/);
  assert.doesNotMatch(outboxBlock, /MANDATE_API_KEY/);
  assert.match(approvalExpiryBlock, /DATABASE_URL_FILE: \/run\/secrets\/approval_expiry_database_url/);
  assert.match(approvalExpiryBlock, /127\.0\.0\.1:8790\/health\/ready/);
});

test('database role command reports fail-closed quiescence without leaking driver errors', async () => {
  const script = await read('scripts/configure-database-roles.js');
  assert.match(script, /rolesRemainQuiesced: error\?\.databaseRolesRemainQuiesced === true/);
  assert.match(script, /DATABASE_ROLE_CONFIGURATION_FAILED/);
  assert.doesNotMatch(script, /error\.message/);
  assert.doesNotMatch(script, /error\.stack/);
});

test('database roles are distinct and identifiers fail closed', () => {
  const config = parseDatabaseRolePolicyConfig({});
  assert.equal(new Set(Object.values(config.roles)).size, 6);
  assert.throws(
    () => parseDatabaseRolePolicyConfig({ MANDATE_DATABASE_API_ROLE: 'unsafe-role' }),
    /Unsafe PostgreSQL role identifier/
  );
  assert.throws(
    () => parseDatabaseRolePolicyConfig({ MANDATE_DATABASE_API_ROLE: 'pg_read_all_data' }),
    /Reserved PostgreSQL role identifier/
  );
  assert.throws(
    () => parseDatabaseRolePolicyConfig({ MANDATE_DATABASE_API_ROLE: 'same', MANDATE_DATABASE_APPROVAL_EXPIRY_ROLE: 'same' }),
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

test('runtime roles are quiesced before ownership is audited and exact grants are restored', async () => {
  const roles = parseDatabaseRolePolicyConfig({}).roles;
  const quiesce = buildDatabaseRoleQuiesceStatements({
    roles,
    databaseName: 'mandate',
    schemaNames: ['mandate', 'public', 'partner_data'],
    tableColumns: [
      { schemaName: 'partner_data', tableName: 'external_events', columnName: 'payload' }
    ]
  }).join('\n');
  assert.match(quiesce, /REVOKE CONNECT ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(quiesce, /REVOKE CREATE ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(quiesce, /REVOKE TEMPORARY ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(quiesce, /REVOKE CREATE ON SCHEMA "partner_data" FROM "mandate_api"/);
  assert.match(quiesce, /REVOKE ALL ON ALL TABLES IN SCHEMA "partner_data" FROM "mandate_api"/);
  assert.match(quiesce, /REVOKE ALL PRIVILEGES \("payload"\) ON TABLE "partner_data"\."external_events" FROM "mandate_api"/);
  assert.match(quiesce, /REVOKE CONNECT ON DATABASE "mandate" FROM "mandate_approval_expiry_worker"/);

  const source = await read('src/deployment/database-role-policy.js');
  const applyPosition = source.indexOf('export async function applyDatabaseRolePolicy');
  const quiescePosition = source.indexOf(
    'const quiesceStatements = buildDatabaseRoleQuiesceStatements({',
    applyPosition
  );
  const terminatePosition = source.indexOf('terminateRuntimeSessions(client, roleNames)', quiescePosition);
  const finalOwnershipPosition = source.indexOf('findRuntimeOwnership(client, roleNames)', terminatePosition);
  const finalPolicyPosition = source.indexOf('buildDatabaseRolePolicyStatements({', finalOwnershipPosition);
  assert.ok(applyPosition > 0);
  assert.ok(quiescePosition > applyPosition);
  assert.ok(terminatePosition > quiescePosition);
  assert.ok(finalOwnershipPosition > terminatePosition);
  assert.ok(finalPolicyPosition > finalOwnershipPosition);
  const terminateFunctionPosition = source.indexOf('async function terminateRuntimeSessions');
  const remainingSessionPosition = source.indexOf('const remaining = await client.query', terminateFunctionPosition);
  const terminationCountPosition = source.indexOf("result.rows.filter((row) => row.terminated === true).length", terminateFunctionPosition);
  assert.ok(remainingSessionPosition > terminateFunctionPosition);
  assert.ok(terminationCountPosition > remainingSessionPosition);
  assert.doesNotMatch(source.slice(terminateFunctionPosition, terminationCountPosition), /Unable to terminate runtime PostgreSQL session/);
});

test('runtime role policy resets every inventoried schema and all routine kinds', () => {
  const roles = parseDatabaseRolePolicyConfig({}).roles;
  const statements = buildDatabaseRolePolicyStatements({
    roles,
    databaseName: 'mandate',
    deploymentRoleName: 'mandate_migrator',
    schemaNames: ['mandate', 'public', 'partner_data'],
    tableColumns: [
      { schemaName: 'mandate', tableName: 'outbox_attempts', columnName: 'id' },
      { schemaName: 'mandate', tableName: 'outbox_attempts', columnName: 'error_code' },
      { schemaName: 'partner_data', tableName: 'external_events', columnName: 'payload' }
    ]
  });
  const joined = statements.join('\n');
  assert.match(joined, /REVOKE ALL ON SCHEMA "partner_data" FROM PUBLIC/);
  assert.match(joined, /REVOKE ALL ON ALL TABLES IN SCHEMA "partner_data" FROM "mandate_api"/);
  assert.match(joined, /REVOKE ALL ON ALL SEQUENCES IN SCHEMA "partner_data" FROM "mandate_api"/);
  assert.match(joined, /REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA "partner_data" FROM "mandate_api"/);
  assert.match(joined, /REVOKE ALL PRIVILEGES \("payload"\) ON TABLE "partner_data"\."external_events" FROM PUBLIC/);
  assert.match(joined, /ALTER DEFAULT PRIVILEGES FOR ROLE "mandate_migrator" IN SCHEMA "partner_data" REVOKE EXECUTE ON ROUTINES FROM "mandate_api"/);
  assert.match(joined, /REVOKE CREATE ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(joined, /REVOKE TEMPORARY ON DATABASE "mandate" FROM "mandate_api"/);
  assert.match(joined, /GRANT SELECT, DELETE ON TABLE mandate\.idempotency_records TO "mandate_maintenance"/);
  assert.match(joined, /GRANT SELECT, INSERT, UPDATE ON TABLE mandate\.approval_assignments TO "mandate_api"/);
  assert.match(joined, /GRANT SELECT, INSERT ON TABLE mandate\.approval_assignment_eligibility TO "mandate_api"/);
  assert.match(joined, /GRANT SELECT, UPDATE ON TABLE mandate\.approvals TO "mandate_approval_expiry_worker"/);
  assert.match(joined, /GRANT SELECT, UPDATE ON TABLE mandate\.approval_assignments TO "mandate_approval_expiry_worker"/);
  assert.doesNotMatch(joined, /ALL FUNCTIONS IN SCHEMA/);
  assert.doesNotMatch(joined, /GRANT EXECUTE/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_api"/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_expiry_worker"/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_approval_expiry_worker"/);
  assert.doesNotMatch(joined, /GRANT [^;]*DELETE[^;]*TO "mandate_outbox_worker"/);
  assert.doesNotMatch(joined, /GRANT [^;]*CREATE[^;]*TO "mandate_/);
  assert.equal(databaseRolePolicy.requiredMigration, '014_approval_expiry');
  assert.deepEqual(databaseRolePolicy.functionRoles, []);
});

test('approval administration stays API-only while approval expiry gets only terminalization authority', () => {
  const grants = databaseRolePolicy.tableGrants;
  assert.deepEqual(grants.api.approver_identities, ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(grants.api.approver_credential_bindings, ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(grants.api.approver_groups, ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(grants.api.approver_group_memberships, ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(grants.api.approval_assignments, ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(grants.api.approval_assignment_eligibility, ['SELECT', 'INSERT']);

  for (const role of ['expiry', 'outbox', 'maintenance', 'operator']) {
    assert.equal(grants[role].approver_identities, undefined);
    assert.equal(grants[role].approval_assignments, undefined);
    assert.equal(grants[role].approval_assignment_eligibility, undefined);
  }
  assert.equal(grants.approvalExpiry.approver_identities, undefined);
  assert.equal(grants.approvalExpiry.approval_assignment_eligibility, undefined);
  assert.deepEqual(grants.approvalExpiry.approvals, ['SELECT', 'UPDATE']);
  assert.deepEqual(grants.approvalExpiry.approval_assignments, ['SELECT', 'UPDATE']);
});

test('worker and operator table privileges remain narrowly separated', () => {
  const grants = databaseRolePolicy.tableGrants;
  assert.deepEqual(grants.outbox.outbox_messages, ['SELECT', 'UPDATE']);
  assert.deepEqual(grants.outbox.outbox_attempts, ['SELECT', 'INSERT']);
  assert.equal(grants.outbox.receipts, undefined);
  assert.deepEqual(grants.expiry.action_attempts, ['SELECT', 'UPDATE']);
  assert.equal(grants.expiry.approvals, undefined);
  assert.equal(grants.expiry.outbox_attempts, undefined);
  assert.deepEqual(grants.approvalExpiry.approvals, ['SELECT', 'UPDATE']);
  assert.deepEqual(grants.approvalExpiry.approval_assignments, ['SELECT', 'UPDATE']);
  assert.equal(grants.approvalExpiry.action_attempts, undefined);
  assert.equal(grants.approvalExpiry.outbox_attempts, undefined);
  assert.deepEqual(grants.operator.outbox_dead_letter_replays, ['SELECT', 'INSERT']);
  assert.equal(grants.operator.idempotency_records, undefined);
});
