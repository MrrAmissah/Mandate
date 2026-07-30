import {
  assertDeadLetterOperationsSchema,
  listDeadLetterMessages,
  parseDeadLetterListConfig
} from '../src/application/outbox-dead-letter-operations.js';
import { createPostgresPool } from '../src/store/postgres-store.js';

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'OUTBOX_DEAD_LETTER_LIST_FAILED';
}

async function main() {
  const config = parseDeadLetterListConfig();
  const pool = await createPostgresPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl
  });
  try {
    await assertDeadLetterOperationsSchema(pool);
    const messages = await listDeadLetterMessages(pool, config);
    console.log(JSON.stringify({
      event: 'outbox_dead_letter.list',
      at: new Date().toISOString(),
      environment: config.environment,
      tenantId: config.tenantId ?? null,
      eventTypes: config.eventTypes ?? null,
      limit: config.limit,
      returned: messages.length,
      messages
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'outbox_dead_letter.list_failed',
    at: new Date().toISOString(),
    errorCode: safeErrorCode(error)
  }));
  process.exitCode = 1;
});
