const RUNTIME_ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
export const DATABASE_ROLE_POLICY_VERSION = '2026-07-30.2';

const ROLE_ENVIRONMENT = Object.freeze({
  api: 'MANDATE_DATABASE_API_ROLE',
  expiry: 'MANDATE_DATABASE_EXPIRY_ROLE',
  outbox: 'MANDATE_DATABASE_OUTBOX_ROLE',
  maintenance: 'MANDATE_DATABASE_MAINTENANCE_ROLE',
  operator: 'MANDATE_DATABASE_OPERATOR_ROLE'
});

const DEFAULT_ROLES = Object.freeze({
  api: 'mandate_api',
  expiry: 'mandate_expiry_worker',
  outbox: 'mandate_outbox_worker',
  maintenance: 'mandate_maintenance',
  operator: 'mandate_operator'
});

const TABLE_GRANTS = Object.freeze({
  api: Object.freeze({
    schema_migrations: ['SELECT'],
    tenants: ['SELECT', 'INSERT', 'UPDATE'],
    api_credentials: ['SELECT', 'INSERT', 'UPDATE'],
    mandates: ['SELECT', 'INSERT', 'UPDATE'],
    approvals: ['SELECT', 'INSERT', 'UPDATE'],
    authorization_decisions: ['SELECT', 'INSERT'],
    receipts: ['SELECT', 'INSERT'],
    idempotency_records: ['SELECT', 'INSERT', 'UPDATE'],
    audit_sequences: ['SELECT', 'INSERT', 'UPDATE'],
    audit_events: ['SELECT', 'INSERT'],
    outbox_messages: ['SELECT', 'INSERT'],
    signing_keys: ['SELECT', 'INSERT', 'UPDATE'],
    action_attempts: ['SELECT', 'INSERT', 'UPDATE']
  }),
  expiry: Object.freeze({
    schema_migrations: ['SELECT'],
    action_attempts: ['SELECT', 'UPDATE'],
    audit_sequences: ['SELECT', 'INSERT', 'UPDATE'],
    audit_events: ['SELECT', 'INSERT'],
    outbox_messages: ['SELECT', 'INSERT']
  }),
  outbox: Object.freeze({
    schema_migrations: ['SELECT'],
    outbox_messages: ['SELECT', 'UPDATE'],
    outbox_attempts: ['SELECT', 'INSERT']
  }),
  maintenance: Object.freeze({
    schema_migrations: ['SELECT'],
    idempotency_records: ['SELECT', 'DELETE']
  }),
  operator: Object.freeze({
    schema_migrations: ['SELECT'],
    outbox_messages: ['SELECT', 'INSERT', 'UPDATE'],
    outbox_attempts: ['SELECT'],
    outbox_dead_letter_replays: ['SELECT', 'INSERT'],
    audit_sequences: ['SELECT', 'INSERT', 'UPDATE'],
    audit_events: ['SELECT', 'INSERT']
  })
});

const REQUIRED_MIGRATION = '010_outbox_dead_letter_replays';

function quoteRuntimeRole(value) {
  if (!RUNTIME_ROLE_IDENTIFIER.test(value)) throw new Error(`Unsafe PostgreSQL role identifier: ${value}`);
  return `"${value}"`;
}

function quoteServerIdentifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) {
    throw new Error(`PostgreSQL ${label} identifier is unavailable or invalid.`);
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > 63) throw new Error(`PostgreSQL ${label} identifier exceeds 63 bytes.`);
  return `"${value.replaceAll('"', '""')}"`;
}

export function parseDatabaseRolePolicyConfig(env = process.env) {
  const roles = {};
  for (const [key, environmentName] of Object.entries(ROLE_ENVIRONMENT)) {
    roles[key] = env[environmentName] ?? DEFAULT_ROLES[key];
    quoteRuntimeRole(roles[key]);
  }
  if (new Set(Object.values(roles)).size !== Object.values(roles).length) {
    throw new Error('Every Mandate database role must have a distinct name.');
  }
  return Object.freeze({ roles: Object.freeze(roles) });
}

function grantStatement(role, table, privileges) {
  return `GRANT ${privileges.join(', ')} ON TABLE mandate.${table} TO ${quoteRuntimeRole(role)};`;
}

export function buildDatabaseRolePolicyStatements({ roles, databaseName, deploymentRoleName }) {
  const quotedDatabase = quoteServerIdentifier(databaseName, 'database');
  const quotedDeploymentRole = quoteServerIdentifier(deploymentRoleName, 'deployment role');
  const statements = [
    `REVOKE CONNECT ON DATABASE ${quotedDatabase} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${quotedDeploymentRole};`,
    'REVOKE ALL ON SCHEMA mandate FROM PUBLIC;',
    'REVOKE ALL ON ALL TABLES IN SCHEMA mandate FROM PUBLIC;',
    'REVOKE ALL ON ALL SEQUENCES IN SCHEMA mandate FROM PUBLIC;',
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mandate FROM PUBLIC;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA mandate REVOKE ALL ON TABLES FROM PUBLIC;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA mandate REVOKE ALL ON SEQUENCES FROM PUBLIC;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA mandate REVOKE ALL ON FUNCTIONS FROM PUBLIC;'
  ];

  for (const role of Object.values(roles)) {
    const quotedRole = quoteRuntimeRole(role);
    statements.push(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${quotedRole};`);
    statements.push(`GRANT USAGE ON SCHEMA mandate TO ${quotedRole};`);
    statements.push(`REVOKE CREATE ON SCHEMA mandate FROM ${quotedRole};`);
    statements.push(`REVOKE ALL ON ALL TABLES IN SCHEMA mandate FROM ${quotedRole};`);
    statements.push(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA mandate FROM ${quotedRole};`);
    statements.push(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mandate FROM ${quotedRole};`);
  }

  for (const [roleKey, tables] of Object.entries(TABLE_GRANTS)) {
    for (const [table, privileges] of Object.entries(tables)) {
      statements.push(grantStatement(roles[roleKey], table, privileges));
    }
  }
  return Object.freeze(statements);
}

export async function applyDatabaseRolePolicy(client, config) {
  const roleNames = Object.values(config.roles);
  const roleResult = await client.query(
    `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
       FROM pg_roles
      WHERE rolname = ANY($1::text[])`,
    [roleNames]
  );
  const found = new Map(roleResult.rows.map((row) => [row.rolname, row]));
  for (const roleName of roleNames) {
    const role = found.get(roleName);
    if (!role) throw new Error(`Required PostgreSQL role does not exist: ${roleName}`);
    if (role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls) {
      throw new Error(`Runtime PostgreSQL role has unsafe attributes: ${roleName}`);
    }
  }

  const databaseResult = await client.query('SELECT current_database() AS database_name, current_user AS deployment_role_name');
  const databaseName = databaseResult.rows[0]?.database_name;
  const deploymentRoleName = databaseResult.rows[0]?.deployment_role_name;
  quoteServerIdentifier(databaseName, 'database');
  quoteServerIdentifier(deploymentRoleName, 'deployment role');
  if (roleNames.includes(deploymentRoleName)) throw new Error('The deployment role must be separate from every runtime role.');

  const memberships = await client.query(
    `SELECT member.rolname AS member_name, parent.rolname AS granted_role
       FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = ANY($1::text[])`,
    [roleNames]
  );
  if (memberships.rowCount > 0) {
    const membership = memberships.rows[0];
    throw new Error(`Runtime PostgreSQL role inherits another role: ${membership.member_name} -> ${membership.granted_role}`);
  }

  const ownership = await client.query(
    `SELECT owner_name, object_name
       FROM (
         SELECT owner.rolname AS owner_name, 'database:' || database.datname AS object_name
           FROM pg_database database
           JOIN pg_roles owner ON owner.oid = database.datdba
          WHERE database.datname = current_database()
         UNION ALL
         SELECT owner.rolname, 'schema:' || namespace.nspname
           FROM pg_namespace namespace
           JOIN pg_roles owner ON owner.oid = namespace.nspowner
          WHERE namespace.nspname = 'mandate'
         UNION ALL
         SELECT owner.rolname, 'relation:' || namespace.nspname || '.' || relation.relname
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_roles owner ON owner.oid = relation.relowner
          WHERE namespace.nspname = 'mandate'
       ) owned
      WHERE owner_name = ANY($1::text[])
      LIMIT 1`,
    [roleNames]
  );
  if (ownership.rowCount > 0) {
    const object = ownership.rows[0];
    throw new Error(`Runtime PostgreSQL role owns a protected object: ${object.owner_name} owns ${object.object_name}`);
  }

  const registry = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'mandate' AND table_name = 'schema_migrations'
     ) AS registry_exists`
  );
  if (!registry.rows[0]?.registry_exists) throw new Error('Mandate migrations must run before database roles are configured.');
  const migration = await client.query('SELECT 1 FROM mandate.schema_migrations WHERE version = $1', [REQUIRED_MIGRATION]);
  if (migration.rowCount !== 1) throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied.`);

  const statements = buildDatabaseRolePolicyStatements({ roles: config.roles, databaseName, deploymentRoleName });
  await client.query('BEGIN');
  try {
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return Object.freeze({
    policyVersion: DATABASE_ROLE_POLICY_VERSION,
    databaseName,
    deploymentRoleName,
    roles: config.roles,
    statementCount: statements.length
  });
}

export const databaseRolePolicy = Object.freeze({
  requiredMigration: REQUIRED_MIGRATION,
  roles: DEFAULT_ROLES,
  tableGrants: TABLE_GRANTS,
  functionRoles: Object.freeze([])
});
