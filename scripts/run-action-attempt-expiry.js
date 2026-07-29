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

const runtime = await createActionAttemptExpiryRuntime();
try {
  await runtime.process.run({ signal: controller.signal });
} finally {
  await runtime.close();
}
