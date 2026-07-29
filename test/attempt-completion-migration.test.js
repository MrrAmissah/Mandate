import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const upPath = new URL('../migrations/006_attempt_completion_receipts.up.sql', import.meta.url);
const downPath = new URL('../migrations/006_attempt_completion_receipts.down.sql', import.meta.url);
const runnerPath = new URL('../src/store/postgres-migrations.js', import.meta.url);

test('attempt completion migration binds terminal evidence and receipts', async () => {
  const sql = await readFile(upPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /ADD COLUMN execution_status/);
  assert.match(sql, /action_attempts_terminal_shape_check/);
  assert.match(sql, /status = 'COMPLETED'/);
  assert.match(sql, /input_hash ~ '\^sha256:/);
  assert.match(sql, /ADD COLUMN action_attempt_id text/);
  assert.match(sql, /receipts_action_attempt_fk/);
  assert.match(sql, /receipts_action_attempt_unique_idx/);
  assert.match(sql, /complete-action-attempt:%/);
  assert.match(sql, /cancel-action-attempt:%/);
  assert.match(sql, /006_attempt_completion_receipts/);
});

test('migration runner orders completion after reservation', async () => {
  const source = await readFile(runnerPath, 'utf8');
  const reservation = source.indexOf("version: '005_action_attempt_reservations'");
  const completion = source.indexOf("version: '006_attempt_completion_receipts'");
  assert.ok(reservation >= 0 && reservation < completion);
});

test('completion rollback restores the reservation-only contract', async () => {
  const sql = await readFile(downPath, 'utf8');
  assert.match(sql, /DROP COLUMN IF EXISTS action_attempt_id/);
  assert.match(sql, /DROP COLUMN IF EXISTS execution_status/);
  assert.doesNotMatch(sql, /complete-action-attempt:%/);
  assert.doesNotMatch(sql, /DROP SCHEMA/);
});
