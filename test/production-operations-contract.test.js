import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function serviceBlock(compose, name, nextName) {
  const start = compose.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `missing Compose service ${name}`);
  const end = nextName ? compose.indexOf(`\n  ${nextName}:`, start + 1) : compose.indexOf('\nnetworks:', start + 1);
  assert.ok(end > start, `unable to bound Compose service ${name}`);
  return compose.slice(start, end);
}

test('production topology bounds resources, logs, shutdown and restart behavior', async () => {
  const compose = await read('deployment/compose.production.yaml');
  assert.match(compose, /pids_limit: 256/);
  assert.match(compose, /cpus: "\$\{MANDATE_SERVICE_CPUS:-1\.0\}"/);
  assert.match(compose, /mem_limit: \$\{MANDATE_SERVICE_MEMORY_LIMIT:-512m\}/);
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /stop_signal: SIGTERM/);
  assert.match(compose, /stop_grace_period: 30s/);
  assert.match(compose, /driver: json-file/);
  assert.match(compose, /max-size: "\$\{MANDATE_LOG_MAX_SIZE:-10m\}"/);
  assert.match(compose, /max-file: "\$\{MANDATE_LOG_MAX_FILES:-5\}"/);
  assert.match(compose, /\/tmp:rw,noexec,nosuid,nodev,size=64m/);

  const migrate = serviceBlock(compose, 'migrate', 'configure-database-roles');
  const rolePolicy = serviceBlock(compose, 'configure-database-roles', 'api');
  assert.match(migrate, /restart: "no"/);
  assert.match(rolePolicy, /restart: "no"/);
});

test('reference network posture publishes only the API and keeps worker operations internal', async () => {
  const compose = await read('deployment/compose.production.yaml');
  const api = serviceBlock(compose, 'api', 'attempt-expiry');
  const expiry = serviceBlock(compose, 'attempt-expiry', 'outbox');
  const outbox = serviceBlock(compose, 'outbox');

  assert.match(api, /"\$\{MANDATE_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{MANDATE_API_PORT:-8787\}:8787"/);
  assert.match(expiry, /expose:\n\s+- "8788"/);
  assert.match(outbox, /expose:\n\s+- "8789"/);
  assert.doesNotMatch(expiry, /\n\s+ports:/);
  assert.doesNotMatch(outbox, /\n\s+ports:/);
});

test('operations runbook is tied to emitted metrics and does not turn samples into exact counts', async () => {
  const operations = await read('docs/PRODUCTION_OPERATIONS.md');
  const expiryHealth = await read('src/application/action-attempt-expiry-health.js');
  const outboxHealth = await read('src/application/outbox-worker-health.js');

  const metrics = [
    'mandate_action_attempt_expiry_ready',
    'mandate_action_attempt_expiry_consecutive_failures',
    'mandate_action_attempt_expiry_backlog_due',
    'mandate_action_attempt_expiry_oldest_overdue_seconds',
    'mandate_action_attempt_expiry_limit_reached_total',
    'mandate_outbox_ready',
    'mandate_outbox_consecutive_failures',
    'mandate_outbox_dead_lettered_total',
    'mandate_outbox_has_due',
    'mandate_outbox_has_stale',
    'mandate_outbox_has_dead_letter',
    'mandate_outbox_limit_reached_total'
  ];

  for (const metric of metrics) {
    assert.match(operations, new RegExp(metric));
    const source = metric.startsWith('mandate_outbox_') ? outboxHealth : expiryHealth;
    assert.match(source, new RegExp(metric));
  }

  assert.match(operations, /capped samples, not exact global queue counts/i);
  assert.match(operations, /never be auto-replayed/i);
  assert.match(operations, /engineering objectives rather than customer-facing SLOs/i);
  assert.match(operations, /initial operational defaults/i);
});

test('operations contract preserves safe rollout and database authority boundaries', async () => {
  const operations = await read('docs/PRODUCTION_OPERATIONS.md');
  assert.match(operations, /migration identity/i);
  assert.match(operations, /database-role configuration/i);
  assert.match(operations, /previous image is compatible with the already-applied schema/i);
  assert.match(operations, /Database migrations are not automatically reversed/i);
  assert.match(operations, /do not change runtime services to use the migration owner/i);
  assert.match(operations, /live dead-letter replay should be treated as prohibited/i);
  assert.match(operations, /provider-neutral/i);
});

test('top-level documentation no longer reports completed operational controls as missing', async () => {
  const readme = await read('README.md');
  const roadmap = await read('docs/ROADMAP.md');
  const deployment = await read('docs/PRODUCTION_DEPLOYMENT.md');

  assert.match(readme, /snapshot-consistent PostgreSQL backup\/restore tooling/i);
  assert.match(readme, /separate migration, API, expiry, outbox, maintenance and operator PostgreSQL authorities/i);
  assert.match(readme, /controlled dead-letter inspection and replay/i);
  assert.match(roadmap, /Phase 2I — database authority, recovery and production supervision/);
  assert.match(roadmap, /Repository-controlled Phase 2 operational hardening is therefore closed/);
  assert.match(deployment, /Backup and restore proof/);
  assert.doesNotMatch(readme, /backup\/restore, dead-letter operations.*remain open/i);
  assert.doesNotMatch(roadmap, /Remaining Phase 2 operational hardening:\s*\n\s*- deployment migration-role separation/i);
});
