import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const NODE_DIGEST = 'sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';
const POSTGRES_DIGEST = 'sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

test('production and CI base images are digest-pinned', async () => {
  const [dockerfile, workflow] = await Promise.all([
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  ]);
  assert.equal(dockerfile.split(NODE_DIGEST).length - 1, 2);
  assert.doesNotMatch(dockerfile, /ARG NODE_IMAGE/);
  assert.match(workflow, new RegExp(`postgres:16-alpine@${POSTGRES_DIGEST}`));
});
