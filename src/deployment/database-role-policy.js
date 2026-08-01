const RUNTIME_ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
export const DATABASE_ROLE_POLICY_VERSION = '2026-07-30.9';

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
const POLICY_LOCK_NAME = 'mandate:database-role-policy';
const SESSION_TERMINATION_TIMEOUT_MS = 5_000;

function quoteRuntimeRole(value) {
  if (!RUNTIME_ROLE_IDENTIFIER.test(value)) throw new Error(`Unsafe PostgreSQL role identifier: ${value}`);
  if (value.startsWith('pg_')) throw new Error(`Reserved PostgreSQL role identifier: ${value}`);
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

function normalizedSchemaNames(schemaNames) {
  if (!Array.isArray(schemaNames) || schemaNames.length === 0) {
    throw new Error('At least one non-system PostgreSQL schema is required.');
  }
  const names = [...new Set(schemaNames)].sort();
  for (const name of names) quoteServerIdentifier(name, 'schema');
  if (!names.includes('mandate')) throw new Error('The mandate schema is required for database role configuration.');
  return names;
}

function normalizedTableColumns(tableColumns) {
  if (!Array.isArray(tableColumns)) throw new Error('Table-column inventory must be an array.');
  const byObject = new Map();
  for (const entry of tableColumns) {
    const schemaName = entry?.schemaName ?? 'mandate';
    const tableName = entry?.tableName;
    const columnName = entry?.columnName;
    quoteServerIdentifier(schemaName, 'schema');
    quoteServerIdentifier(tableName, 'table');
    quoteServerIdentifier(columnName, 'column');
    const key = `${schemaName}\0${tableName}`;
    if (!byObject.has(key)) byObject.set(key, { schemaName, tableName, columns: new Set() });
    byObject.get(key).columns.add(columnName);
  }
  return [...byObject.values()]
    .sort((left, right) => {
      const schema = left.schemaName.localeCompare(right.schemaName, 'en');
      return schema === 0 ? left.tableName.localeCompare(right.tableName, 'en') : schema;
    })
    .map(({ schemaName, tableName, columns }) => Object.freeze({
      schemaName,
      tableName,
      columns: Object.freeze([...columns].sort((left, right) => left.localeCompare(right, 'en')))
    }));
}

function defaultPrivilegeRevokes(deploymentRole, grantee, schemaName = null) {
  const scope = schemaName === null
    ? ''
    : ` IN SCHEMA ${quoteServerIdentifier(schemaName, 'schema')}`;
  return [
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${deploymentRole}${scope} REVOKE ALL ON TABLES FROM ${grantee};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${deploymentRole}${scope} REVOKE ALL ON SEQUENCES FROM ${grantee};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${deploymentRole}${scope} REVOKE EXECUTE ON ROUTINES FROM ${grantee};`
  ];
}

function columnPrivilegeRevokes(tableColumns, grantee) {
  return tableColumns.map(({ schemaName, tableName, columns }) => {
    const quotedSchema = quoteServerIdentifier(schemaName, 'schema');
    const quotedTable = quoteServerIdentifier(tableName, 'table');
    const quotedColumns = columns.map((column) => quoteServerIdentifier(column, 'column')).join(', ');
    return `REVOKE ALL PRIVILEGES (${quotedColumns}) ON TABLE ${quotedSchema}.${quotedTable} FROM ${grantee};`;
  });
}

function schemaObjectPrivilegeRevokes(schemaNames, grantee) {
  const statements = [];
  for (const schemaName of schemaNames) {
    const quotedSchema = quoteServerIdentifier(schemaName, 'schema');
    statements.push(
      `REVOKE ALL ON SCHEMA ${quotedSchema} FROM ${grantee};`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${quotedSchema} FROM ${grantee};`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${quotedSchema} FROM ${grantee};`,
      `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${quotedSchema} FROM ${grantee};`
    );
  }
  return statements;
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

export function buildDatabaseRoleQuiesceStatements({
  roles,
  databaseName,
  schemaNames = ['mandate', 'public'],
  tableColumns = []
}) {
  const quotedDatabase = quoteServerIdentifier(databaseName, 'database');
  const schemas = normalizedSchemaNames(schemaNames);
  const columns = normalizedTableColumns(tableColumns);
  const statements = [
    `REVOKE CONNECT ON DATABASE ${quotedDatabase} FROM PUBLIC;`,
    `REVOKE CREATE ON DATABASE ${quotedDatabase} FROM PUBLIC;`,
    `REVOKE TEMPORARY ON DATABASE ${quotedDatabase} FROM PUBLIC;`
  ];
  for (const schemaName of schemas) {
    statements.push(`REVOKE CREATE ON SCHEMA ${quoteServerIdentifier(schemaName, 'schema')} FROM PUBLIC;`);
  }
  statements.push(...schemaObjectPrivilegeRevokes(schemas, 'PUBLIC'));
  statements.push(...columnPrivilegeRevokes(columns, 'PUBLIC'));
  for (const role of Object.values(roles)) {
    const quotedRole = quoteRuntimeRole(role);
    statements.push(`REVOKE CONNECT ON DATABASE ${quotedDatabase} FROM ${quotedRole};`);
    statements.push(`REVOKE CREATE ON DATABASE ${quotedDatabase} FROM ${quotedRole};`);
    statements.push(`REVOKE TEMPORARY ON DATABASE ${quotedDatabase} FROM ${quotedRole};`);
    for (const schemaName of schemas) {
      statements.push(`REVOKE CREATE ON SCHEMA ${quoteServerIdentifier(schemaName, 'schema')} FROM ${quotedRole};`);
    }
    statements.push(...schemaObjectPrivilegeRevokes(schemas, quotedRole));
    statements.push(...columnPrivilegeRevokes(columns, quotedRole));
  }
  return Object.freeze(statements);
}

export function buildDatabaseRolePolicyStatements({
  roles,
  databaseName,
  deploymentRoleName,
  schemaNames = ['mandate', 'public'],
  tableColumns = []
}) {
  const quotedDatabase = quoteServerIdentifier(databaseName, 'database');
  const quotedDeploymentRole = quoteServerIdentifier(deploymentRoleName, 'deployment role');
  const schemas = normalizedSchemaNames(schemaNames);
  const columns = normalizedTableColumns(tableColumns);
  const statements = [
    `REVOKE CONNECT ON DATABASE ${quotedDatabase} FROM PUBLIC;`,
    `REVOKE CREATE ON DATABASE ${quotedDatabase} FROM PUBLIC;`,
    `REVOKE TEMPORARY ON DATABASE ${quotedDatabase} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${quotedDeploymentRole};`,
    ...schemas.map((schemaName) =>
      `REVOKE CREATE ON SCHEMA ${quoteServerIdentifier(schemaName, 'schema')} FROM PUBLIC;`
    ),
    ...schemaObjectPrivilegeRevokes(schemas, 'PUBLIC'),
    ...columnPrivilegeRevokes(columns, 'PUBLIC'),
    ...defaultPrivilegeRevokes(quotedDeploymentRole, 'PUBLIC')
  ];
  for (const schemaName of schemas) {
    statements.push(...defaultPrivilegeRevokes(quotedDeploymentRole, 'PUBLIC', schemaName));
  }

  for (const role of Object.values(roles)) {
    const quotedRole = quoteRuntimeRole(role);
    statements.push(`REVOKE CREATE ON DATABASE ${quotedDatabase} FROM ${quotedRole};`);
    statements.push(`REVOKE TEMPORARY ON DATABASE ${quotedDatabase} FROM ${quotedRole};`);
    for (const schemaName of schemas) {
      statements.push(`REVOKE CREATE ON SCHEMA ${quoteServerIdentifier(schemaName, 'schema')} FROM ${quotedRole};`);
    }
    statements.push(...schemaObjectPrivilegeRevokes(schemas, quotedRole));
    statements.push(...columnPrivilegeRevokes(columns, quotedRole));
    statements.push(...defaultPrivilegeRevokes(quotedDeploymentRole, quotedRole));
    for (const schemaName of schemas) {
      statements.push(...defaultPrivilegeRevokes(quotedDeploymentRole, quotedRole, schemaName));
    }
    statements.push(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${quotedRole};`);
    statements.push(`GRANT USAGE ON SCHEMA mandate TO ${quotedRole};`);
  }

  for (const [roleKey, tables] of Object.entries(TABLE_GRANTS)) {
    for (const [table, privileges] of Object.entries(tables)) {
      statements.push(grantStatement(roles[roleKey], table, privileges));
    }
  }
  return Object.freeze(statements);
}

async function executeTransaction(client, statements) {
  await client.query('BEGIN');
  try {
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function findRuntimeOwnership(client, roleNames) {
  const result = await client.query(
    `SELECT owner.rolname AS owner_name,
            pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid) AS object_name
       FROM pg_shdepend dependency
       JOIN pg_roles owner ON owner.oid = dependency.refobjid
       JOIN pg_database current_database_entry ON current_database_entry.datname = current_database()
      WHERE dependency.refclassid = 'pg_authid'::regclass
        AND dependency.deptype = 'o'
        AND owner.rolname = ANY($1::text[])
        AND (
          dependency.dbid = current_database_entry.oid
          OR (
            dependency.dbid = 0
            AND dependency.classid = 'pg_database'::regclass
            AND dependency.objid = current_database_entry.oid
          )
        )
      ORDER BY owner.rolname, object_name
      LIMIT 1`,
    [roleNames]
  );
  return result.rows[0] ?? null;
}

function assertNoRuntimeOwnership(object) {
  if (object) {
    throw new Error(`Runtime PostgreSQL role owns a protected object: ${object.owner_name} owns ${object.object_name}`);
  }
}

async function assertNoRuntimePreparedTransactions(client, roleNames) {
  const result = await client.query(
    `SELECT gid, owner
       FROM pg_prepared_xacts
      WHERE database = current_database()
        AND owner = ANY($1::text[])
      ORDER BY owner, gid
      LIMIT 1`,
    [roleNames]
  );
  if (result.rowCount > 0) {
    const transaction = result.rows[0];
    throw new Error(`Runtime PostgreSQL role owns a prepared transaction: ${transaction.owner} owns ${transaction.gid}`);
  }
}

async function terminateRuntimeSessions(client, roleNames) {
  const result = await client.query(
    `SELECT pid, pg_terminate_backend(pid, $2::bigint) AS terminated
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = ANY($1::text[])
        AND pid <> pg_backend_pid()`,
    [roleNames, SESSION_TERMINATION_TIMEOUT_MS]
  );
  const remaining = await client.query(
    `SELECT pid
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = ANY($1::text[])
        AND pid <> pg_backend_pid()
      LIMIT 1`,
    [roleNames]
  );
  if (remaining.rowCount > 0) {
    throw new Error(`Runtime PostgreSQL session remained active after termination: ${remaining.rows[0].pid}`);
  }
  return result.rows.filter((row) => row.terminated === true).length;
}

async function loadSchemaNames(client) {
  const result = await client.query(
    `SELECT nspname
       FROM pg_namespace
      WHERE nspname !~ '^pg_'
        AND nspname <> 'information_schema'
      ORDER BY nspname`
  );
  return normalizedSchemaNames(result.rows.map((row) => row.nspname));
}

async function loadTableColumns(client, schemaNames) {
  const result = await client.query(
    `SELECT namespace.nspname AS schema_name,
            relation.relname AS table_name,
            attribute.attname AS column_name
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY namespace.nspname, relation.relname, attribute.attnum`,
    [schemaNames]
  );
  return result.rows.map((row) => Object.freeze({
    schemaName: row.schema_name,
    tableName: row.table_name,
    columnName: row.column_name
  }));
}

export async function applyDatabaseRolePolicy(client, config) {
  const roleNames = Object.values(config.roles);
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [POLICY_LOCK_NAME]);
  let quiesced = false;
  try {
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

    const databaseResult = await client.query(
      'SELECT current_database() AS database_name, current_user AS deployment_role_name'
    );
    const databaseName = databaseResult.rows[0]?.database_name;
    const deploymentRoleName = databaseResult.rows[0]?.deployment_role_name;
    quoteServerIdentifier(databaseName, 'database');
    quoteServerIdentifier(deploymentRoleName, 'deployment role');
    if (roleNames.includes(deploymentRoleName)) {
      throw new Error('The deployment role must be separate from every runtime role.');
    }

    const registry = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'mandate' AND table_name = 'schema_migrations'
       ) AS registry_exists`
    );
    if (!registry.rows[0]?.registry_exists) {
      throw new Error('Mandate migrations must run before database roles are configured.');
    }
    const migration = await client.query(
      'SELECT 1 FROM mandate.schema_migrations WHERE version = $1',
      [REQUIRED_MIGRATION]
    );
    if (migration.rowCount !== 1) throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied.`);

    const memberships = await client.query(
      `SELECT member.rolname AS member_name, parent.rolname AS granted_role
         FROM pg_auth_members membership
         JOIN pg_roles member ON member.oid = membership.member
         JOIN pg_roles parent ON parent.oid = membership.roleid
        WHERE member.rolname = ANY($1::text[])
           OR parent.rolname = ANY($1::text[])
        ORDER BY member.rolname, parent.rolname
        LIMIT 1`,
      [roleNames]
    );
    if (memberships.rowCount > 0) {
      const membership = memberships.rows[0];
      throw new Error(`Runtime PostgreSQL role participates in role inheritance: ${membership.member_name} -> ${membership.granted_role}`);
    }

    assertNoRuntimeOwnership(await findRuntimeOwnership(client, roleNames));
    await assertNoRuntimePreparedTransactions(client, roleNames);
    let schemaNames = await loadSchemaNames(client);
    let tableColumns = await loadTableColumns(client, schemaNames);

    const quiesceStatements = buildDatabaseRoleQuiesceStatements({
      roles: config.roles,
      databaseName,
      schemaNames,
      tableColumns
    });
    await executeTransaction(client, quiesceStatements);
    quiesced = true;

    const terminatedSessionCount = await terminateRuntimeSessions(client, roleNames);
    await assertNoRuntimePreparedTransactions(client, roleNames);
    assertNoRuntimeOwnership(await findRuntimeOwnership(client, roleNames));

    schemaNames = await loadSchemaNames(client);
    tableColumns = await loadTableColumns(client, schemaNames);
    const tableCount = normalizedTableColumns(tableColumns).length;
    const statements = buildDatabaseRolePolicyStatements({
      roles: config.roles,
      databaseName,
      deploymentRoleName,
      schemaNames,
      tableColumns
    });
    await executeTransaction(client, statements);
    quiesced = false;

    return Object.freeze({
      policyVersion: DATABASE_ROLE_POLICY_VERSION,
      databaseName,
      deploymentRoleName,
      schemaNames: Object.freeze(schemaNames),
      tableCount,
      roles: config.roles,
      terminatedSessionCount,
      statementCount: quiesceStatements.length + statements.length
    });
  } catch (error) {
    if (quiesced && error && typeof error === 'object') error.databaseRolesRemainQuiesced = true;
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [POLICY_LOCK_NAME]).catch(() => {});
  }
}

export const databaseRolePolicy = Object.freeze({
  requiredMigration: REQUIRED_MIGRATION,
  roles: DEFAULT_ROLES,
  tableGrants: TABLE_GRANTS,
  functionRoles: Object.freeze([])
});
