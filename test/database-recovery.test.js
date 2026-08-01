import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSnapshotMatchesManifest,
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
    MANDATE_BACKUP_LABEL: 'nightly-2026-08-01'
  });
  assert.equal(config.source.databaseName, 'mandate');
  assert.equal(config.label, 'nightly-2026-08-01');
  assert.equal(config.pgDumpPath, 'pg_dump');
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

test('database tool receives the connection URL only through PGDATABASE', async () => {
  let observed;
  const spawnImpl = (command, args, options) => {
    observed = { command, args, options };
    const handlers = new Map();
    const child = {
      stderr: { setEncoding() {}, on() {} },
      on(event, handler) {
        handlers.set(event, handler);
        if (event === 'close') queueMicrotask(() => handler(0, null));
        return child;
      }
    };
    return child;
  };
  await runDatabaseTool('pg_dump', ['--format=custom'], {
    databaseUrl: 'postgresql://user:secret@db.example/mandate',
    spawnImpl
  });
  assert.equal(observed.command, 'pg_dump');
  assert.deepEqual(observed.args, ['--format=custom']);
  assert.equal(observed.options.env.PGDATABASE, 'postgresql://user:secret@db.example/mandate');
  assert.equal(observed.args.some((value) => value.includes('secret')), false);
  assert.deepEqual(observed.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('database tool failures return safe codes without exposing stderr text', async () => {
  const spawnImpl = () => {
    const handlers = new Map();
    const child = {
      stderr: {
        setEncoding() {},
        on(event, handler) {
          if (event === 'data') handler('password=super-secret');
        }
      },
      on(event, handler) {
        handlers.set(event, handler);
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

test('restore verification requires exact migration and critical-table counts', () => {
  const migrations = ['001_initial', '010_outbox_dead_letter_replays'];
  const counts = {
    tenants: '1',
    api_credentials: '2',
    mandates: '3',
    approvals: '4',
    authorization_decisions: '5',
    action_attempts: '6',
    receipts: '7',
    audit_events: '8',
    outbox_messages: '9',
    signing_keys: '10'
  };
  assert.doesNotThrow(() => assertSnapshotMatchesManifest({ migrations, counts }, { migrations, counts }));
  assert.throws(
    () => assertSnapshotMatchesManifest({ migrations, counts: { ...counts, receipts: '8' } }, { migrations, counts }),
    (error) => error?.code === 'DATABASE_RESTORE_COUNT_MISMATCH'
  );
  assert.throws(
    () => assertSnapshotMatchesManifest({ migrations: ['001_initial'], counts }, { migrations, counts }),
    (error) => error?.code === 'DATABASE_RESTORE_MIGRATION_MISMATCH'
  );
});
