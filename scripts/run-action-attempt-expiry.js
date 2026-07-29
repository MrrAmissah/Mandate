import { createActionAttemptExpiryRuntime } from '../src/application/action-attempt-expiry-process.js';

const controller = new AbortController();
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({
      event: 'action_attempt_expiry.shutdown_requested',
      signal,
      at: new Date().toISOString()
    }));
    controller.abort();
  });
}

async function main() {
  const runtime = await createActionAttemptExpiryRuntime();
  try {
    await runtime.process.run({ signal: controller.signal });
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'EXPIRY_STARTUP_FAILED';
  console.error(JSON.stringify({
    event: 'action_attempt_expiry.startup_failed',
    at: new Date().toISOString(),
    errorCode
  }));
  process.exitCode = 1;
});
