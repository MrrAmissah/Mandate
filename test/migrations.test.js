import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const upPath = new URL('../migrations/001_durable_core.up.sql', import.meta.url);
const downPath = new URL('../migrations/001_durable_core.down.sql', import.meta.url);

async function migration() {
  return readFile(upPath, 'utf8');
}

test('durable core migration is transactional and tenant-aware', async () => {
  const sql = await migration();
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);

  for (const table of [
    'api_credentials',
    'mandates',
    'approvals',
    'authorization_decisions',
    'receipts',
    'idempotency_records',
    'audit_events',
    'outbox_messages'
  ]) {
    const tableBlock = sql.match(new RegExp(`CREATE TABLE mandate\\.${table} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(tableBlock, `missing ${table} table`);
    assert.match(tableBlock[1], /tenant_id text NOT NULL/);
    assert.match(tableBlock[1], /environment text NOT NULL/);
  }
});

test('decisions, receipts, and audit events are database-immutable', async () => {
  const sql = await migration();
  assert.match(sql, /authorization_decisions_immutable/);
  assert.match(sql, /receipts_immutable/);
  assert.match(sql, /audit_events_immutable/);
  assert.match(sql, /reject_immutable_change/);
});

test('schema enforces idempotency, one receipt per decision, and outbox leases', async () => {
  const sql = await migration();
  assert.match(sql, /PRIMARY KEY \(tenant_id, environment, scope, idempotency_key\)/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, decision_id\)/);
  assert.match(sql, /outbox_due_idx/);
  assert.match(sql, /status = 'PROCESSING'.*locked_by IS NOT NULL/s);
});

test('development down migration removes only the dedicated schema', async () => {
  const sql = await readFile(downPath, 'utf8');
  assert.equal(sql.trim(), 'BEGIN;\nDROP SCHEMA IF EXISTS mandate CASCADE;\nCOMMIT;');
});
