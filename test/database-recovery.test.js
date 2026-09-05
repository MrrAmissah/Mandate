import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSnapshotMatchesManifest,
  createDatabaseBackup,
  databaseRecovery,
  parseDatabaseBackupConfig,
  parseDatabaseRestoreConfig,
  runDatabaseTool
} from '../src/deployment/database-recovery.js';

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test('backup configuration requires an absolute output directory and PostgreSQL URL', () => {
  throwsCode(
    () => parseDatabaseBackupConfig({ DATABASE_URL: 'https://example.com/db', MANDATE_BACKUP_OUTPUT_DIR: '/tmp' }),
    'DATABASE_BACKUP_URL_INVALID'
  );
  throwsCode(
    () => parseDatabaseBackupConfig({ DATABASE_URL: 'postgresql://db/app', MANDATE_BACKUP_OUTPUT_DIR: 'relative' }),
    'DATABASE_BACKUP_OUTPUT_UNSAFE'
  );
  const config = parseDatabaseBackupConfig({
    DATABASE_URL: 'postgresql://user:secret@db.example/mandate',
    MANDATE_BACKUP_OUTPUT_DIR: '/var/backups/mandate',
    MANDATE_BACKUP_LABEL: 'nightly-2026-08-01',
    MANDATE_DATABASE_SSL: 'true'
  });
  assert.equal(config.source.databaseName, 'mandate');
  assert.equal(config.label, 'nightly-2026-08-01');
  assert.equal(config.pgDumpPath, 'pg_dump');
  assert.equal(config.databaseSsl, true);
});

test('generated backup label is valid without operator input', () => {
  const config = parseDatabaseBackupConfig({
    DATABASE_URL: 'postgresql://db.example/mandate',
    MANDATE_BACKUP_OUTPUT_DIR: '/var/backups/mandate'
  });
  assert.match(config.label, /^[a-z0-9][a-z0-9._-]{0,63}$/);
});

test('restore configuration accepts only explicitly disposable databases and absolute artifacts', () => {
  throwsCode(
    () => parseDatabaseRestoreConfig({
      MANDATE_RECOVERY_TARGET_URL: 'postgresql://user:secret@db.example/mandate',
      MANDATE_RECOVERY_BACKUP_PATH: '/backups/mandate.dump'
    }),
    'DATABASE_RESTORE_TARGET_UNSAFE'
  );
  throwsCode(
    () => parseDatabaseRestoreConfig({
      MANDATE_RECOVERY_TARGET_URL: 'postgresql://user:secret@db.example/mandate_restore_test',
      MANDATE_RECOVERY_BACKUP_PATH: 'mandate.dump'
    }),
    'DATABASE_RESTORE_BACKUP_UNSAFE'
  );
  const config = parseDatabaseRestoreConfig({
    MANDATE_RECOVERY_TARGET_URL: 'postgresql://user:secret@db.example/mandate_restore_drill01',
    MANDATE_RECOVERY_BACKUP_PATH: '/backups/mandate.dump'
  });
  assert.equal(config.target.databaseName, 'mandate_restore_drill01');
  assert.equal(config.manifestPath, '/backups/mandate.dump.manifest.json');
});

test('database tool receives credentials only through PostgreSQL environment variables', async () => {
  let observed;
  const spawnImpl = (command, args, options) => {
    observed = { command, args, options };
    const child = {
      stderr: { setEncoding() {}, on() {} },
      on(event, handler) {
        if (event === 'close') queueMicrotask(() => handler(0, null));
        return child;
      }
    };
    return child;
  };
  await runDatabaseTool('pg_dump', ['--format=custom'], {
    databaseUrl: 'postgresql://user:secret@db.example:5433/mandate',
    databaseSsl: true,
    spawnImpl
  });
  assert.equal(observed.command, 'pg_dump');
  assert.deepEqual(observed.args, ['--format=custom']);
  assert.equal(observed.options.env.PGHOST, 'db.example');
  assert.equal(observed.options.env.PGPORT, '5433');
  assert.equal(observed.options.env.PGDATABASE, 'mandate');
  assert.equal(observed.options.env.PGUSER, 'user');
  assert.equal(observed.options.env.PGPASSWORD, 'secret');
  assert.equal(observed.options.env.PGSSLMODE, 'require');
  assert.equal(observed.args.some((value) => value.includes('secret')), false);
  assert.deepEqual(observed.options.stdio, ['ignore', 'ignore', 'pipe']);
});

test('database tool failures return safe codes without exposing stderr text', async () => {
  const spawnImpl = () => {
    const child = {
      stderr: {
        setEncoding() {},
        on(event, handler) {
          if (event === 'data') handler('password=super-secret');
        }
      },
      on(event, handler) {
        if (event === 'close') queueMicrotask(() => handler(2, null));
        return child;
      }
    };
    return child;
  };
  await assert.rejects(
    runDatabaseTool('pg_dump', [], { databaseUrl: 'postgresql://db/app', spawnImpl }),
    (error) => {
      assert.equal(error.code, 'DATABASE_TOOL_FAILED');
      assert.equal(error.stderrObserved, true);
      assert.equal(error.message.includes('super-secret'), false);
      return true;
    }
  );
});

test('backup uses one exported snapshot and keeps the destination reserved until publication', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'mandate-backup-test-'));
  const queries = [];
  let toolArgs;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'SELECT pg_export_snapshot() AS snapshot_id') return { rows: [{ snapshot_id: '00000003-0000001b-1' }] };
      if (sql.includes('FROM mandate.schema_migrations')) {
        return { rows: [{ version: '010_outbox_dead_letter_replays' }] };
      }
      if (sql.includes('SELECT count(*)::bigint')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    },
    release() {}
  };
  const poolFactory = async (options) => ({
    options,
    async connect() { return client; },
    async end() {}
  });
  const toolRunner = async (_command, args, options) => {
    toolArgs = { args, options };
    const finalIndex = args.indexOf('--file');
    assert.ok(finalIndex >= 0);
    const finalPath = args[finalIndex + 1];
    await writeFile(finalPath, Buffer.from('postgres-custom-dump-fixture'));
  };
  const config = parseDatabaseBackupConfig({
    DATABASE_URL: 'postgresql://user:secret@db.example/mandate',
    MANDATE_BACKUP_OUTPUT_DIR: outputDirectory,
    MANDATE_BACKUP_LABEL: 'snapshot-test',
    MANDATE_DATABASE_SSL: 'true'
  });
  try {
    const result = await createDatabaseBackup(config, { poolFactory, toolRunner });
    assert.ok(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.ok(queries.includes('SELECT pg_export_snapshot() AS snapshot_id'));
    assert.ok(queries.includes('COMMIT'));
    assert.deepEqual(
      toolArgs.args.slice(toolArgs.args.indexOf('--snapshot'), toolArgs.args.indexOf('--snapshot') + 2),
      ['--snapshot', '00000003-0000001b-1']
    );
    assert.equal(toolArgs.options.databaseSsl, true);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.counts.idempotency_records, '0');
    assert.equal(manifest.counts.outbox_dead_letter_replays, '0');
    await assert.rejects(
      createDatabaseBackup(config, { poolFactory, toolRunner }),
      (error) => error?.code === 'DATABASE_BACKUP_EXISTS'
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('restore verification requires exact migration and critical-table counts', () => {
  const migrations = ['001_initial', '010_outbox_dead_letter_replays'];
  const counts = Object.fromEntries(databaseRecovery.criticalTables.map((table, index) => [table, String(index + 1)]));
  assert.doesNotThrow(() => assertSnapshotMatchesManifest({ migrations, counts }, { migrations, counts }));
  assert.throws(
    () => assertSnapshotMatchesManifest({ migrations, counts: { ...counts, receipts: '999' } }, { migrations, counts }),
    (error) => error?.code === 'DATABASE_RESTORE_COUNT_MISMATCH'
  );
  assert.throws(
    () => assertSnapshotMatchesManifest({ migrations: ['001_initial'], counts }, { migrations, counts }),
    (error) => error?.code === 'DATABASE_RESTORE_MIGRATION_MISMATCH'
  );
});
