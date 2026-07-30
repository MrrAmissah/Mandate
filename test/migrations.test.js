import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baselineUpPath = new URL('../migrations/001_durable_core.up.sql', import.meta.url);
const baselineDownPath = new URL('../migrations/001_durable_core.down.sql', import.meta.url);
const outboxUpPath = new URL('../migrations/002_outbox_attempts.up.sql', import.meta.url);
const outboxDownPath = new URL('../migrations/002_outbox_attempts.down.sql', import.meta.url);
const idempotencyUpPath = new URL('../migrations/003_idempotency_http_metadata.up.sql', import.meta.url);
const idempotencyDownPath = new URL('../migrations/003_idempotency_http_metadata.down.sql', import.meta.url);
const retentionUpPath = new URL('../migrations/008_idempotency_retention.up.sql', import.meta.url);
const retentionDownPath = new URL('../migrations/008_idempotency_retention.down.sql', import.meta.url);
const outboxWorkerUpPath = new URL('../migrations/009_outbox_worker_operations.up.sql', import.meta.url);
const outboxWorkerDownPath = new URL('../migrations/009_outbox_worker_operations.down.sql', import.meta.url);
const replayUpPath = new URL('../migrations/010_outbox_dead_letter_replays.up.sql', import.meta.url);
const replayDownPath = new URL('../migrations/010_outbox_dead_letter_replays.down.sql', import.meta.url);
const runnerPath = new URL('../src/store/postgres-migrations.js', import.meta.url);

async function baselineMigration() {
  return readFile(baselineUpPath, 'utf8');
}

test('durable core migration is transactional and tenant-aware', async () => {
  const sql = await baselineMigration();
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  for (const table of [
    'api_credentials', 'mandates', 'approvals', 'authorization_decisions',
    'receipts', 'idempotency_records', 'audit_events', 'outbox_messages'
  ]) {
    const tableBlock = sql.match(new RegExp(`CREATE TABLE mandate\\.${table} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(tableBlock, `missing ${table} table`);
    assert.match(tableBlock[1], /tenant_id text NOT NULL/);
    assert.match(tableBlock[1], /environment text NOT NULL/);
  }
});

test('decisions, receipts, and audit events are database-immutable', async () => {
  const sql = await baselineMigration();
  assert.match(sql, /authorization_decisions_immutable/);
  assert.match(sql, /receipts_immutable/);
  assert.match(sql, /audit_events_immutable/);
  assert.match(sql, /reject_immutable_change/);
});

test('schema enforces idempotency, one receipt per decision, and outbox leases', async () => {
  const sql = await baselineMigration();
  assert.match(sql, /PRIMARY KEY \(tenant_id, environment, scope, idempotency_key\)/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, decision_id\)/);
  assert.match(sql, /outbox_due_idx/);
  assert.match(sql, /status = 'PROCESSING'.*locked_by IS NOT NULL/s);
});

test('missing-mandate denials remain persistable while receipts require real mandates', async () => {
  const sql = await baselineMigration();
  const decisions = sql.match(new RegExp('CREATE TABLE mandate\\.authorization_decisions \\(([\\s\\S]*?)\\n\\);'))[1];
  assert.doesNotMatch(decisions, /FOREIGN KEY \(tenant_id, environment, mandate_id\)/);
  const receipts = sql.match(new RegExp('CREATE TABLE mandate\\.receipts \\(([\\s\\S]*?)\\n\\);'))[1];
  assert.match(receipts, /FOREIGN KEY \(tenant_id, environment, mandate_id\)/);
});

test('outbox attempt migration is transactional, append-only, and lease-evidence aware', async () => {
  const sql = await readFile(outboxUpPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE TABLE mandate\.outbox_attempts/);
  assert.match(sql, /LEASE_EXPIRED/);
  assert.match(sql, /LEASE_LOST/);
  assert.match(sql, /outbox_attempts_immutable/);
  assert.match(sql, /reject_immutable_change/);
  assert.match(sql, /002_outbox_attempts/);
});

test('idempotency metadata migration maps known scopes and rejects unknown scopes', async () => {
  const sql = await readFile(idempotencyUpPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /assign_idempotency_http_metadata/);
  assert.match(sql, /create-mandate.*create-approval.*issue-receipt/s);
  assert.match(sql, /revoke-mandate:%/);
  assert.match(sql, /decide-approval:%/);
  assert.match(sql, /unknown idempotency scope/);
  assert.match(sql, /content-type.*application\/json; charset=utf-8/s);
  assert.match(sql, /003_idempotency_http_metadata/);
});

test('idempotency retention migration adds only the scoped cleanup index', async () => {
  const sql = await readFile(retentionUpPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE INDEX idempotency_retention_scope_idx/);
  assert.match(sql, /environment, tenant_id, expires_at, created_at, scope, idempotency_key/);
  assert.match(sql, /008_idempotency_retention/);
  assert.doesNotMatch(sql, /DELETE FROM mandate\.idempotency_records|UPDATE mandate\.idempotency_records/);
});

test('outbox worker migration adds status-specific scope and event indexes only', async () => {
  const sql = await readFile(outboxWorkerUpPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE INDEX outbox_worker_pending_idx/);
  assert.match(sql, /CREATE INDEX outbox_worker_processing_idx/);
  assert.match(sql, /CREATE INDEX outbox_worker_dead_letter_idx/);
  assert.match(sql, /environment, tenant_id, event_type, available_at, created_at, id/);
  assert.match(sql, /environment, tenant_id, event_type, lock_expires_at, created_at, id/);
  assert.match(sql, /environment, tenant_id, event_type, processed_at, created_at, id/);
  assert.match(sql, /009_outbox_worker_operations/);
  assert.doesNotMatch(sql, /UPDATE mandate\.outbox_messages|DELETE FROM mandate\.outbox_messages/);
});

test('dead-letter replay migration separates business and operator provenance', async () => {
  const sql = await readFile(replayUpPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE TABLE mandate\.outbox_dead_letter_replays/);
  assert.match(sql, /operator_audit_event_id text NOT NULL/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, source_message_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, replay_message_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, operator_audit_event_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, idempotency_key_hash\)/);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, environment, operator_audit_event_id\)[\s\S]*REFERENCES mandate\.audit_events/
  );
  assert.match(sql, /outbox_dead_letter_replays_immutable/);
  assert.match(sql, /reject_immutable_change/);
  assert.match(sql, /010_outbox_dead_letter_replays/);
  assert.doesNotMatch(sql, /UPDATE mandate\.outbox_messages|DELETE FROM mandate\.outbox_messages/);
});

test('migration runner applies all migrations in order under one advisory lock', async () => {
  const source = await readFile(runnerPath, 'utf8');
  const versions = [
    '001_durable_core', '002_outbox_attempts', '003_idempotency_http_metadata',
    '004_signing_key_lifecycle', '005_action_attempt_reservations',
    '006_attempt_completion_receipts', '007_receipt_supersession',
    '008_idempotency_retention', '009_outbox_worker_operations',
    '010_outbox_dead_letter_replays'
  ];
  const positions = versions.map((version) => source.indexOf(`version: '${version}'`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(source, /pg_advisory_lock\(hashtextextended/);
  assert.match(source, /pg_advisory_unlock\(hashtextextended/);
  assert.match(source, /mandate:migrations/);
});

test('development down migrations remove only their owned objects', async () => {
  const baseline = await readFile(baselineDownPath, 'utf8');
  assert.equal(baseline.trim(), 'BEGIN;\nDROP SCHEMA IF EXISTS mandate CASCADE;\nCOMMIT;');
  const outbox = await readFile(outboxDownPath, 'utf8');
  assert.match(outbox, /DELETE FROM mandate\.schema_migrations WHERE version = '002_outbox_attempts'/);
  assert.match(outbox, /DROP TABLE IF EXISTS mandate\.outbox_attempts/);
  assert.doesNotMatch(outbox, /DROP SCHEMA/);
  const idempotency = await readFile(idempotencyDownPath, 'utf8');
  assert.match(idempotency, /DROP TRIGGER IF EXISTS idempotency_http_metadata/);
  assert.match(idempotency, /DROP FUNCTION IF EXISTS mandate\.assign_idempotency_http_metadata/);
  assert.match(idempotency, /DELETE FROM mandate\.schema_migrations WHERE version = '003_idempotency_http_metadata'/);
  assert.doesNotMatch(idempotency, /DROP TABLE|DROP SCHEMA/);
  const retention = await readFile(retentionDownPath, 'utf8');
  assert.match(retention, /DROP INDEX IF EXISTS mandate\.idempotency_retention_scope_idx/);
  assert.match(retention, /DELETE FROM mandate\.schema_migrations WHERE version = '008_idempotency_retention'/);
  assert.doesNotMatch(retention, /DROP TABLE|DROP SCHEMA/);
  const outboxWorker = await readFile(outboxWorkerDownPath, 'utf8');
  assert.match(outboxWorker, /DROP INDEX IF EXISTS mandate\.outbox_worker_pending_idx/);
  assert.match(outboxWorker, /DROP INDEX IF EXISTS mandate\.outbox_worker_processing_idx/);
  assert.match(outboxWorker, /DROP INDEX IF EXISTS mandate\.outbox_worker_dead_letter_idx/);
  assert.match(outboxWorker, /DELETE FROM mandate\.schema_migrations WHERE version = '009_outbox_worker_operations'/);
  assert.doesNotMatch(outboxWorker, /DROP TABLE|DROP SCHEMA/);
  const replay = await readFile(replayDownPath, 'utf8');
  assert.match(replay, /DROP TABLE IF EXISTS mandate\.outbox_dead_letter_replays/);
  assert.match(replay, /DELETE FROM mandate\.schema_migrations WHERE version = '010_outbox_dead_letter_replays'/);
  assert.doesNotMatch(replay, /DROP SCHEMA/);
});
