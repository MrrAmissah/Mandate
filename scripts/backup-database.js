import {
  createDatabaseBackup,
  parseDatabaseBackupConfig
} from '../src/deployment/database-recovery.js';

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'DATABASE_BACKUP_FAILED';
}

async function main() {
  const config = parseDatabaseBackupConfig();
  const result = await createDatabaseBackup(config);
  console.log(JSON.stringify({
    event: 'database_backup.completed',
    at: new Date().toISOString(),
    artifact: result.backupPath,
    manifest: result.manifestPath,
    sha256: result.sha256,
    sizeBytes: result.sizeBytes
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'database_backup.failed',
    at: new Date().toISOString(),
    errorCode: safeErrorCode(error)
  }));
  process.exitCode = 1;
});
