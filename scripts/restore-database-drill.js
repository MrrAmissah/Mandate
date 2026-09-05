import {
  parseDatabaseRestoreConfig,
  restoreAndVerifyDatabase
} from '../src/deployment/database-recovery.js';

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'DATABASE_RESTORE_DRILL_FAILED';
}

async function main() {
  const config = parseDatabaseRestoreConfig();
  const result = await restoreAndVerifyDatabase(config);
  console.log(JSON.stringify({
    event: 'database_restore_drill.completed',
    at: new Date().toISOString(),
    targetDatabase: result.targetDatabase,
    sha256: result.sha256,
    migrations: result.migrations,
    counts: result.counts
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'database_restore_drill.failed',
    at: new Date().toISOString(),
    errorCode: safeErrorCode(error)
  }));
  process.exitCode = 1;
});
