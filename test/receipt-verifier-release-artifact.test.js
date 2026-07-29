import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { buildReceiptVerifierArtifact } from '../scripts/package-receipt-verifier.js';

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

test('receipt verifier packaging emits a reproducible tarball and stable integrity manifest', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mandate-artifact-test-'));
  const outputDirectory = join(temporaryRoot, 'output');
  try {
    const result = await buildReceiptVerifierArtifact({ outputDirectory });
    assert.equal(result.packageName, '@mandate-api/receipt-verifier');
    assert.equal(result.packageVersion, '0.2.0');
    assert.equal(result.reproducible, true);
    assert.match(result.filename, /^mandate-api-receipt-verifier-0\.2\.0\.tgz$/);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.packedSize > 0);
    assert.ok(result.unpackedSize > result.packedSize);
    assert.equal(result.entryCount, result.files.length);

    const artifactPath = join(outputDirectory, result.filename);
    assert.equal(await digest(artifactPath), result.sha256);
    assert.equal(
      await readFile(join(outputDirectory, 'SHA256SUMS'), 'utf8'),
      `${result.sha256}  ${result.filename}\n`
    );

    const manifest = JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      packageName: result.packageName,
      packageVersion: result.packageVersion,
      filename: result.filename,
      sha256: result.sha256,
      npmShasum: result.npmShasum,
      npmIntegrity: result.npmIntegrity,
      packedSize: result.packedSize,
      unpackedSize: result.unpackedSize,
      entryCount: result.entryCount,
      reproducible: true,
      files: result.files
    });
    assert.equal('createdAt' in manifest, false);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      [
        'README.md',
        'canonical-json.d.ts',
        'canonical-json.js',
        'index.d.ts',
        'index.js',
        'key-set-cache.js',
        'package.json'
      ]
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('receipt verifier packaging refuses a filesystem root output directory', async () => {
  await assert.rejects(
    buildReceiptVerifierArtifact({ outputDirectory: parse(tmpdir()).root }),
    /cannot be a filesystem root/
  );
});

test('receipt verifier packaging rejects private key material before npm pack runs', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mandate-private-package-test-'));
  const packageDirectory = join(temporaryRoot, 'package');
  try {
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: '@example/private-fixture',
      version: '1.0.0',
      files: ['index.js']
    }), 'utf8');
    await writeFile(join(packageDirectory, 'README.md'), '# Test\n', 'utf8');
    await writeFile(
      join(packageDirectory, 'index.js'),
      'export const value = `-----BEGIN PRIVATE KEY-----`;',
      'utf8'
    );

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
});
