import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createPostgresPool } from '../store/postgres-store.js';

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESTORE_DATABASE_PATTERN = /^mandate_restore_[a-z0-9_]{1,40}$/;
const REQUIRED_MIGRATION = '012_approval_decision_credential_evidence';
const CRITICAL_TABLES = Object.freeze([
  'tenants',
  'api_credentials',
  'mandates',
  'approvals',
  'approver_identities',
  'approver_credential_bindings',
  'approver_groups',
  'approver_group_memberships',
  'approval_assignments',
  'approval_assignment_eligibility',
  'authorization_decisions',
  'action_attempts',
  'receipts',
  'idempotency_records',
  'audit_sequences',
  'audit_events',
  'outbox_messages',
  'outbox_attempts',
  'outbox_dead_letter_replays',
  'signing_keys'
]);

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, code, message) {
  if (typeof value !== 'string' || value.trim().length === 0) throw recoveryError(code, message);
  return value.trim();
}

function parseConnectionUrl(value, code) {
  const raw = requiredString(value, code, 'A PostgreSQL connection URL is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw recoveryError(code, 'The PostgreSQL connection URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw recoveryError(code, 'The connection URL must use postgres:// or postgresql://.');
  }
  if (!url.hostname || !url.pathname || url.pathname === '/') {
    throw recoveryError(code, 'The PostgreSQL connection URL must include a host and database name.');
  }
  return Object.freeze({ raw, databaseName: decodeURIComponent(url.pathname.slice(1)) });
}

function safeToolPath(value, fallback, code) {
  const tool = (value ?? fallback).trim();
  if (tool.length === 0 || tool.includes('\0')) throw recoveryError(code, 'Database tool path is invalid.');
  return tool;
}

function postgresToolEnvironment(databaseUrl, databaseSsl = false) {
  const parsed = parseConnectionUrl(databaseUrl, 'DATABASE_TOOL_URL_INVALID');
  const url = new URL(parsed.raw);
  const env = { ...process.env };
  env.PGHOST = url.hostname;
  env.PGDATABASE = parsed.databaseName;
  if (url.port) env.PGPORT = url.port;
  else delete env.PGPORT;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  else delete env.PGUSER;
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  else delete env.PGPASSWORD;
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  else if (databaseSsl) env.PGSSLMODE = 'require';
  else delete env.PGSSLMODE;
  return env;
}

export function parseDatabaseBackupConfig(env = process.env) {
  const source = parseConnectionUrl(env.DATABASE_URL, 'DATABASE_BACKUP_URL_INVALID');
  const outputDirectory = requiredString(
    env.MANDATE_BACKUP_OUTPUT_DIR,
    'DATABASE_BACKUP_OUTPUT_REQUIRED',
    'MANDATE_BACKUP_OUTPUT_DIR is required.'
  );
  if (!isAbsolute(outputDirectory)) {
    throw recoveryError('DATABASE_BACKUP_OUTPUT_UNSAFE', 'Backup output directory must be absolute.');
  }
  const generatedLabel = new Date().toISOString().replaceAll(':', '-').toLowerCase();
  const label = (env.MANDATE_BACKUP_LABEL ?? generatedLabel).trim();
  if (!LABEL_PATTERN.test(label)) throw recoveryError('DATABASE_BACKUP_LABEL_INVALID', 'Backup label is invalid.');
  return Object.freeze({
    source,
    outputDirectory: resolve(outputDirectory),
    label,
    pgDumpPath: safeToolPath(env.MANDATE_PG_DUMP_PATH, 'pg_dump', 'DATABASE_BACKUP_TOOL_INVALID'),
    databaseSsl: env.MANDATE_DATABASE_SSL === 'true'
  });
}

export function parseDatabaseRestoreConfig(env = process.env) {
  const target = parseConnectionUrl(env.MANDATE_RECOVERY_TARGET_URL, 'DATABASE_RESTORE_URL_INVALID');
  if (!RESTORE_DATABASE_PATTERN.test(target.databaseName)) {
    throw recoveryError(
      'DATABASE_RESTORE_TARGET_UNSAFE',
      'Recovery target database must use the mandate_restore_ prefix.'
    );
  }
  const backupPath = requiredString(
    env.MANDATE_RECOVERY_BACKUP_PATH,
    'DATABASE_RESTORE_BACKUP_REQUIRED',
    'MANDATE_RECOVERY_BACKUP_PATH is required.'
  );
  if (!isAbsolute(backupPath)) {
    throw recoveryError('DATABASE_RESTORE_BACKUP_UNSAFE', 'Recovery backup path must be absolute.');
  }
  return Object.freeze({
    target,
    backupPath: resolve(backupPath),
    manifestPath: `${resolve(backupPath)}.manifest.json`,
    pgRestorePath: safeToolPath(env.MANDATE_PG_RESTORE_PATH, 'pg_restore', 'DATABASE_RESTORE_TOOL_INVALID'),
    databaseSsl: env.MANDATE_DATABASE_SSL === 'true'
  });
}

export function runDatabaseTool(command, args, { databaseUrl, databaseSsl = false, spawnImpl = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: postgresToolEnvironment(databaseUrl, databaseSsl)
    });
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on('error', () => reject(recoveryError('DATABASE_TOOL_START_FAILED', 'Database tool could not start.')));
    child.on('close', (code, signal) => {
      if (code === 0) return resolvePromise();
      const error = recoveryError('DATABASE_TOOL_FAILED', 'Database tool exited unsuccessfully.');
      error.exitCode = Number.isInteger(code) ? code : null;
      error.signal = signal ?? null;
      error.stderrObserved = stderr.length > 0;
      reject(error);
    });
  });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function loadRecoverySnapshot(queryable) {
  const migrationResult = await queryable.query(
    `SELECT version
       FROM mandate.schema_migrations
      ORDER BY applied_at DESC, version DESC`
  );
  if (!migrationResult.rows.some((row) => row.version === REQUIRED_MIGRATION)) {
    throw recoveryError('DATABASE_RECOVERY_SCHEMA_NOT_READY', `Required migration ${REQUIRED_MIGRATION} is absent.`);
  }
  const counts = {};
  for (const table of CRITICAL_TABLES) {
    const result = await queryable.query(`SELECT count(*)::bigint AS count FROM mandate.${table}`);
    counts[table] = result.rows[0].count;
  }
  return Object.freeze({
    migrations: Object.freeze(migrationResult.rows.map((row) => row.version)),
    counts: Object.freeze(counts)
  });
}

async function reservePath(fs, path) {
  const reservation = await fs.open(path, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') throw recoveryError('DATABASE_BACKUP_EXISTS', 'Backup destination already exists.');
    throw error;
  });
  await reservation.close();
}

export async function createDatabaseBackup(config, dependencies = {}) {
  const fs = dependencies.fs ?? { chmod, mkdir, open, rename, rm, stat, writeFile };
  const toolRunner = dependencies.toolRunner ?? runDatabaseTool;
  const poolFactory = dependencies.poolFactory ?? createPostgresPool;
  await fs.mkdir(config.outputDirectory, { recursive: true, mode: 0o700 });
  const directory = await fs.stat(config.outputDirectory);
  if (!directory.isDirectory()) throw recoveryError('DATABASE_BACKUP_OUTPUT_UNSAFE', 'Backup output is not a directory.');

  const finalPath = join(config.outputDirectory, `mandate-${config.label}.dump`);
  const manifestPath = `${finalPath}.manifest.json`;
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryPath = `${finalPath}.partial-${suffix}`;
  const temporaryManifestPath = `${manifestPath}.partial-${suffix}`;
  let finalReserved = false;
  let manifestReserved = false;
  let pool;
  let client;
  let transactionOpen = false;

  try {
    await reservePath(fs, finalPath);
    finalReserved = true;
    await reservePath(fs, manifestPath);
    manifestReserved = true;

    pool = await poolFactory({
      connectionString: config.source.raw,
      max: 1,
      ssl: config.databaseSsl
    });
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const exported = await client.query('SELECT pg_export_snapshot() AS snapshot_id');
    const snapshotId = exported.rows[0]?.snapshot_id;
    if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
      throw recoveryError('DATABASE_BACKUP_SNAPSHOT_FAILED', 'PostgreSQL did not export a backup snapshot.');
    }
    const snapshot = await loadRecoverySnapshot(client);

    await toolRunner(
      config.pgDumpPath,
      [
        '--format=custom',
        '--compress=9',
        '--no-owner',
        '--no-privileges',
        '--snapshot',
        snapshotId,
        '--file',
        temporaryPath
      ],
      { databaseUrl: config.source.raw, databaseSsl: config.databaseSsl }
    );
    await client.query('COMMIT');
    transactionOpen = false;

    await fs.chmod(temporaryPath, 0o600);
    const dumpStat = await fs.stat(temporaryPath);
    if (!dumpStat.isFile() || dumpStat.size < 1) {
      throw recoveryError('DATABASE_BACKUP_EMPTY', 'Backup tool produced an empty artifact.');
    }
    const digest = await sha256File(temporaryPath);
    const manifest = Object.freeze({
      formatVersion: 1,
      artifact: basename(finalPath),
      sha256: digest,
      sizeBytes: dumpStat.size,
      createdAt: new Date().toISOString(),
      requiredMigration: REQUIRED_MIGRATION,
      migrations: snapshot.migrations,
      counts: snapshot.counts
    });
    await fs.writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, finalPath);
    await fs.rename(temporaryManifestPath, manifestPath);
    return Object.freeze({ backupPath: finalPath, manifestPath, sha256: digest, sizeBytes: dumpStat.size });
  } catch (error) {
    if (transactionOpen && client) await client.query('ROLLBACK').catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await fs.rm(temporaryManifestPath, { force: true }).catch(() => {});
    if (finalReserved) await fs.rm(finalPath, { force: true }).catch(() => {});
    if (manifestReserved) await fs.rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    client?.release?.();
    await pool?.end?.();
  }
}

export async function restoreAndVerifyDatabase(config, dependencies = {}) {
  const toolRunner = dependencies.toolRunner ?? runDatabaseTool;
  const poolFactory = dependencies.poolFactory ?? createPostgresPool;
  const backup = await stat(config.backupPath);
  if (!backup.isFile() || backup.size < 1) throw recoveryError('DATABASE_RESTORE_BACKUP_INVALID', 'Backup artifact is empty or missing.');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(config.manifestPath, 'utf8'));
  } catch {
    throw recoveryError('DATABASE_RESTORE_MANIFEST_INVALID', 'Backup manifest is missing or invalid.');
  }
  if (manifest.formatVersion !== 1 || basename(config.backupPath) !== manifest.artifact) {
    throw recoveryError('DATABASE_RESTORE_MANIFEST_INVALID', 'Backup manifest does not match the artifact.');
  }
  const digest = await sha256File(config.backupPath);
  if (digest !== manifest.sha256) throw recoveryError('DATABASE_RESTORE_DIGEST_MISMATCH', 'Backup digest does not match its manifest.');

  await toolRunner(
    config.pgRestorePath,
    [
      '--dbname',
      config.target.databaseName,
      '--clean',
      '--if-exists',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      config.backupPath
    ],
    { databaseUrl: config.target.raw, databaseSsl: config.databaseSsl }
  );

  const pool = await poolFactory({
    connectionString: config.target.raw,
    max: 1,
    ssl: config.databaseSsl
  });
  try {
    const restored = await loadRecoverySnapshot(pool);
    assertSnapshotMatchesManifest(restored, manifest);
    return Object.freeze({
      targetDatabase: config.target.databaseName,
      sha256: digest,
      migrations: restored.migrations.length,
      counts: restored.counts
    });
  } finally {
    await pool.end();
  }
}

export function assertSnapshotMatchesManifest(snapshot, manifest) {
  if (!Array.isArray(manifest.migrations) || JSON.stringify(snapshot.migrations) !== JSON.stringify(manifest.migrations)) {
    throw recoveryError('DATABASE_RESTORE_MIGRATION_MISMATCH', 'Restored migration registry differs from the backup manifest.');
  }
  for (const table of CRITICAL_TABLES) {
    if (String(snapshot.counts[table]) !== String(manifest.counts?.[table])) {
      throw recoveryError('DATABASE_RESTORE_COUNT_MISMATCH', `Restored row count differs for ${table}.`);
    }
  }
}

export const databaseRecovery = Object.freeze({
  requiredMigration: REQUIRED_MIGRATION,
  criticalTables: CRITICAL_TABLES,
  restoreDatabasePattern: RESTORE_DATABASE_PATTERN
});
