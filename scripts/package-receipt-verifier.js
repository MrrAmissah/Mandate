import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const defaultPackageDirectory = join(repositoryRoot, 'packages', 'receipt-verifier');
const defaultOutputDirectory = join(repositoryRoot, 'artifacts', 'receipt-verifier');
const privateKeyPattern = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/;

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function safeOutputDirectory(value) {
  const outputDirectory = resolve(value);
  if (outputDirectory === parse(outputDirectory).root) {
    throw new TypeError('Artifact output directory cannot be a filesystem root.');
  }
  return outputDirectory;
}

function expectedPackageFiles(packageJson) {
  const declared = Array.isArray(packageJson.files) ? packageJson.files : [];
  return [...new Set(['README.md', 'package.json', ...declared])].sort();
}

async function assertPublicPackageSources(packageDirectory, expectedFiles) {
  for (const relativePath of expectedFiles) {
    const source = await readFile(join(packageDirectory, relativePath), 'utf8');
    if (privateKeyPattern.test(source)) {
      throw new Error(`Private key material is not allowed in package file ${relativePath}.`);
    }
  }
}

async function runPack(packageDirectory, destination) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await execute(npm, [
    'pack',
    '--json',
    '--pack-destination',
    destination
  ], {
    cwd: packageDirectory,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  const reports = JSON.parse(stdout);
  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error('npm pack did not return exactly one package report.');
  }
  const report = reports[0];
  if (typeof report.filename !== 'string' || basename(report.filename) !== report.filename) {
    throw new Error('npm pack returned an unsafe artifact filename.');
  }
  return report;
}

function normalizedFiles(report) {
  if (!Array.isArray(report.files)) throw new Error('npm pack report did not include files.');
  return report.files
    .map((file) => ({ path: file.path, size: Number(file.size) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertExactFileSet(report, expectedFiles) {
  const actual = normalizedFiles(report).map((file) => file.path);
  if (JSON.stringify(actual) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Package file set mismatch. Expected ${expectedFiles.join(', ')}; received ${actual.join(', ')}.`);
  }
}

function assertPackageIdentity(report, packageJson) {
  if (report.name !== packageJson.name || report.version !== packageJson.version) {
    throw new Error('npm pack package identity does not match package.json.');
  }
  if (report.id !== `${packageJson.name}@${packageJson.version}`) {
    throw new Error('npm pack package id does not match package.json.');
  }
}

export async function buildReceiptVerifierArtifact({
  packageDirectory = defaultPackageDirectory,
  outputDirectory = defaultOutputDirectory
} = {}) {
  const resolvedPackageDirectory = resolve(packageDirectory);
  const resolvedOutputDirectory = safeOutputDirectory(outputDirectory);
  const packageJson = JSON.parse(await readFile(join(resolvedPackageDirectory, 'package.json'), 'utf8'));
  const expectedFiles = expectedPackageFiles(packageJson);
  await assertPublicPackageSources(resolvedPackageDirectory, expectedFiles);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mandate-receipt-verifier-'));
  const firstDestination = join(temporaryRoot, 'first');
  const secondDestination = join(temporaryRoot, 'second');
  await mkdir(firstDestination);
  await mkdir(secondDestination);

  try {
    const first = await runPack(resolvedPackageDirectory, firstDestination);
    const second = await runPack(resolvedPackageDirectory, secondDestination);
    assertPackageIdentity(first, packageJson);
    assertPackageIdentity(second, packageJson);
    assertExactFileSet(first, expectedFiles);
    assertExactFileSet(second, expectedFiles);

    if (first.filename !== second.filename) {
      throw new Error('Repeated npm pack runs returned different filenames.');
    }
    const firstPath = join(firstDestination, first.filename);
    const secondPath = join(secondDestination, second.filename);
    const firstDigest = await sha256(firstPath);
    const secondDigest = await sha256(secondPath);
    if (firstDigest !== secondDigest) {
      throw new Error('Receipt verifier package is not reproducible across repeated npm pack runs.');
    }
    if (first.shasum !== second.shasum || first.integrity !== second.integrity) {
      throw new Error('Repeated npm pack reports disagree on package integrity metadata.');
    }

    const files = normalizedFiles(first);
    const manifest = Object.freeze({
      schemaVersion: 1,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      filename: first.filename,
      sha256: firstDigest,
      npmShasum: first.shasum,
      npmIntegrity: first.integrity,
      packedSize: Number(first.size),
      unpackedSize: Number(first.unpackedSize),
      entryCount: Number(first.entryCount),
      reproducible: true,
      files
    });

    await rm(resolvedOutputDirectory, { recursive: true, force: true });
    await mkdir(resolvedOutputDirectory, { recursive: true });
    await copyFile(firstPath, join(resolvedOutputDirectory, first.filename));
    await writeFile(
      join(resolvedOutputDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    await writeFile(
      join(resolvedOutputDirectory, 'SHA256SUMS'),
      `${firstDigest}  ${first.filename}\n`,
      'utf8'
    );

    return Object.freeze({
      outputDirectory: resolvedOutputDirectory,
      ...manifest
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] && isAbsolute(process.argv[1])
  ? process.argv[1]
  : process.argv[1]
    ? resolve(process.argv[1])
    : null;

if (invokedPath === fileURLToPath(import.meta.url)) {
  buildReceiptVerifierArtifact({
    outputDirectory: process.env.RECEIPT_VERIFIER_ARTIFACT_DIR ?? defaultOutputDirectory
  }).then((result) => {
    console.log(JSON.stringify({
      event: 'receipt_verifier.package_built',
      packageName: result.packageName,
      packageVersion: result.packageVersion,
      filename: result.filename,
      sha256: result.sha256,
      outputDirectory: result.outputDirectory
    }));
  }).catch((error) => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
      ? error.code
      : 'RECEIPT_VERIFIER_PACKAGE_FAILED';
    console.error(JSON.stringify({
      event: 'receipt_verifier.package_failed',
      errorCode: code
    }));
    process.exitCode = 1;
  });
}
