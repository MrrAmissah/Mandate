import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceiptVerifierArtifact } from '../scripts/package-receipt-verifier.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('receipt verifier packaging rejects output directories that contain the repository', async () => {
  await assert.rejects(
    buildReceiptVerifierArtifact({ outputDirectory: repositoryRoot }),
    /cannot contain the repository or package directory/
  );
  await assert.rejects(
    buildReceiptVerifierArtifact({ outputDirectory: dirname(repositoryRoot) }),
    /cannot contain the repository or package directory/
  );
});

test('receipt verifier packaging rejects alternate PEM private-key headers', async () => {
  for (const header of [
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----'
  ]) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'mandate-private-header-test-'));
    const packageDirectory = join(temporaryRoot, 'package');
    try {
      await mkdir(packageDirectory);
      await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
        name: '@example/private-header-fixture',
        version: '1.0.0',
        files: ['index.js']
      }), 'utf8');
      await writeFile(join(packageDirectory, 'README.md'), '# Test\n', 'utf8');
      await writeFile(join(packageDirectory, 'index.js'), `export const value = \`${header}\`;`, 'utf8');

      await assert.rejects(
        buildReceiptVerifierArtifact({
          packageDirectory,
          outputDirectory: join(temporaryRoot, 'output')
        }),
        /Private key material is not allowed/
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});
