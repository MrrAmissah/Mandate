import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('database role ownership audit includes schema functions', async () => {
  const source = await readFile(
    new URL('../src/deployment/database-role-policy.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /FROM pg_proc procedure/);
  assert.match(source, /JOIN pg_roles owner ON owner\.oid = procedure\.proowner/);
  assert.match(source, /pg_get_function_identity_arguments\(procedure\.oid\)/);
});
