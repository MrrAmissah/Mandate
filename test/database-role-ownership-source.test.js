import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('database role ownership audit uses PostgreSQL shared ownership dependencies', async () => {
  const source = await readFile(
    new URL('../src/deployment/database-role-policy.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /FROM pg_shdepend dependency/);
  assert.match(source, /dependency\.deptype = 'o'/);
  assert.match(source, /pg_describe_object\(dependency\.classid, dependency\.objid, dependency\.objsubid\)/);
  assert.match(source, /dependency\.classid = 'pg_database'::regclass/);
  assert.match(source, /pg_terminate_backend\(pid, \$2::bigint\)/);
  assert.match(source, /FROM pg_prepared_xacts/);
  assert.match(source, /parent\.rolname = ANY\(\$1::text\[\]\)/);
  assert.match(source, /pg_advisory_lock\(hashtextextended\(\$1, 0\)\)/);
});