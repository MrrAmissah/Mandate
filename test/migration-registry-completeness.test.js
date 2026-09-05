import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const runnerPath = new URL('../src/store/postgres-migrations.js', import.meta.url);

function versionFromMigrationFile(name) {
  return name.replace(/\.up\.sql$/, '');
}

test('every forward migration is explicitly registered in filename order and has a rollback file', async () => {
  const entries = await readdir(migrationsDirectory);
  const forwardFiles = entries
    .filter((name) => /^\d{3}_[a-z0-9_]+\.up\.sql$/.test(name))
    .sort();
  const rollbackFiles = new Set(entries.filter((name) => name.endsWith('.down.sql')));
  const source = await readFile(runnerPath, 'utf8');
  const registeredVersions = [...source.matchAll(/version: '([^']+)'/g)].map((match) => match[1]);
  const discoveredVersions = forwardFiles.map(versionFromMigrationFile);

  assert.deepEqual(
    registeredVersions,
    discoveredVersions,
    'postgres-migrations.js must explicitly register every forward migration in filename order'
  );

  for (const version of discoveredVersions) {
    assert.equal(
      rollbackFiles.has(`${version}.down.sql`),
      true,
      `missing development rollback file for ${version}`
    );
  }
});
