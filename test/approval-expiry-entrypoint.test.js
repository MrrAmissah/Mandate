import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packagePath = new URL('../package.json', import.meta.url);
const executablePath = new URL('../scripts/run-approval-expiry.js', import.meta.url);
const processPath = new URL('../src/application/approval-expiry-process.js', import.meta.url);
const healthPath = new URL('../src/application/approval-expiry-health.js', import.meta.url);

test('package exposes a dedicated approval expiry command', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(packageJson.scripts['worker:approval-expiry'], 'node scripts/run-approval-expiry.js');
});

test('approval expiry executable handles signals, starts health, closes resources, and reports safe startup failure', async () => {
  const source = await readFile(executablePath, 'utf8');
  assert.match(source, /SIGINT/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /await runtime\.health\.start\(\)/);
  assert.match(source, /await runtime\.health\.close\(\)/);
  assert.match(source, /await runtime\.close\(\)/);
  assert.match(source, /approval_expiry\.startup_failed/);
  assert.match(source, /APPROVAL_EXPIRY_STARTUP_FAILED/);
  assert.doesNotMatch(source, /console\.error\(error\)|error\.message|error\.stack/);
});

test('approval expiry runtime checks migration 014 without applying migrations or using API keys', async () => {
  const source = await readFile(processPath, 'utf8');
  assert.match(source, /assertApprovalExpirySchema/);
  assert.match(source, /014_approval_expiry/);
  assert.doesNotMatch(source, /applyMigrations|MANDATE_API_KEY/);
  assert.match(source, /DATABASE_URL is required/);
  assert.match(source, /MANDATE_APPROVAL_EXPIRY_WORKER_ID is required in live environments/);
});

test('approval expiry health probes use cached process state and contain no database dependency', async () => {
  const source = await readFile(healthPath, 'utf8');
  assert.match(source, /\/health\/live/);
  assert.match(source, /\/health\/ready/);
  assert.match(source, /\/metrics/);
  assert.match(source, /expiryProcess\.snapshot\(\)/);
  assert.match(source, /expiryProcess\.readiness\(now\)/);
  assert.doesNotMatch(source, /postgres|DATABASE_URL|\.query\(/i);
});
