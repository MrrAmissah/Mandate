import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const upPath = new URL('../migrations/005_action_attempt_reservations.up.sql', import.meta.url);
const downPath = new URL('../migrations/005_action_attempt_reservations.down.sql', import.meta.url);
const runnerPath = new URL('../src/store/postgres-migrations.js', import.meta.url);

test('action attempt migration is transactional and enforces one decision reservation', async () => {
  const sql = await readFile(upPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE TABLE mandate\.action_attempts/);
  assert.match(sql, /UNIQUE \(tenant_id, environment, decision_id\)/);
  assert.match(sql, /REFERENCES mandate\.authorization_decisions/);
  assert.match(sql, /REFERENCES mandate\.mandates/);
  assert.match(sql, /REFERENCES mandate\.api_credentials/);
  assert.match(sql, /status IN \('RESERVED', 'COMPLETED', 'CANCELLED', 'EXPIRED'\)/);
  assert.match(sql, /CHECK \(expires_at > reserved_at\)/);
  assert.match(sql, /reserve-action-attempt/);
  assert.match(sql, /005_action_attempt_reservations/);
});

test('migration runner applies action attempts after signing-key lifecycle', async () => {
  const source = await readFile(runnerPath, 'utf8');
  const signingIndex = source.indexOf("version: '004_signing_key_lifecycle'");
  const attemptIndex = source.indexOf("version: '005_action_attempt_reservations'");
  assert.ok(signingIndex >= 0 && signingIndex < attemptIndex);
});

test('action attempt rollback owns only its table and restores prior idempotency scopes', async () => {
  const sql = await readFile(downPath, 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /DROP TABLE IF EXISTS mandate\.action_attempts/);
  assert.doesNotMatch(sql, /reserve-action-attempt/);
  assert.match(sql, /DELETE FROM mandate\.schema_migrations WHERE version = '005_action_attempt_reservations'/);
  assert.doesNotMatch(sql, /DROP SCHEMA/);
});
