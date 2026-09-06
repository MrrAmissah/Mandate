import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const upPath = new URL('../migrations/014_approval_expiry.up.sql', import.meta.url);
const downPath = new URL('../migrations/014_approval_expiry.down.sql', import.meta.url);
const runnerPath = new URL('../src/store/postgres-migrations.js', import.meta.url);

test('approval expiry migration makes deadline state durable and database-authoritative', async () => {
  const sql = await readFile(upPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /ADD COLUMN expired_at timestamptz/);
  assert.match(sql, /ADD COLUMN expiration_reason text/);
  assert.match(sql, /ADD COLUMN expiration_request_id text/);
  assert.match(sql, /approvals_expiry_evidence_shape/);
  assert.match(sql, /status IN \('ACTIVE', 'SUPERSEDED', 'CANCELLED', 'EXPIRED'\)/);
  assert.match(sql, /approvals_pending_expiry_scope_idx/);
  assert.match(sql, /environment, tenant_id, expires_at, id/);
  assert.match(sql, /clock_timestamp\(\)/);
  assert.match(sql, /approval decision cannot commit after expiry deadline/);
  assert.match(sql, /approval cancellation cannot commit after expiry deadline/);
  assert.match(sql, /approval is unavailable for a new active assignment/);
  assert.match(sql, /approval expiry requires a reached deadline and immutable expiry evidence/);
  assert.match(sql, /expired approval cannot retain an active assignment/);
  assert.match(sql, /event\.type = 'approval\.expired'/);
  assert.match(sql, /event\.actor_type = 'SYSTEM'/);
  assert.match(sql, /approval expiry requires immutable system audit evidence/);
  assert.match(sql, /014_approval_expiry/);
});

test('approval expiry development rollback removes only expiry-owned schema changes', async () => {
  const sql = await readFile(downPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /DROP INDEX IF EXISTS mandate\.approvals_pending_expiry_scope_idx/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS approvals_expiry_evidence_shape/);
  assert.match(sql, /DROP COLUMN IF EXISTS expired_at/);
  assert.match(sql, /DROP COLUMN IF EXISTS expiration_reason/);
  assert.match(sql, /DROP COLUMN IF EXISTS expiration_request_id/);
  assert.match(sql, /DELETE FROM mandate\.schema_migrations\s+WHERE version = '014_approval_expiry'/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP SCHEMA/);
});

test('approval expiry migration is explicitly registered after approval inbox migration', async () => {
  const source = await readFile(runnerPath, 'utf8');
  const inbox = source.indexOf("version: '013_approval_inbox_indexes'");
  const expiry = source.indexOf("version: '014_approval_expiry'");
  assert.ok(inbox >= 0);
  assert.ok(expiry > inbox);
  assert.match(source, /014_approval_expiry\.up\.sql/);
});
