import { createOutboxWorkerRuntime } from '../src/application/outbox-worker-process.js';

const controller = new AbortController();
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({
      event: 'outbox_worker.shutdown_requested',
      signal,
      at: new Date().toISOString()
    }));
    controller.abort();
  });
}

async function main() {
  const runtime = await createOutboxWorkerRuntime();
  let healthStarted = false;
  try {
    const address = await runtime.health.start();
    healthStarted = true;
    console.log(JSON.stringify({
      event: 'outbox_worker.health_started',
      at: new Date().toISOString(),
      host: address.host,
      port: address.port
    }));
    await runtime.process.run({ signal: controller.signal });
  } finally {
    try {
      if (healthStarted) await runtime.health.close();
    } finally {
      await runtime.close();
    }
  }
}

main().catch((error) => {
  const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'OUTBOX_STARTUP_FAILED';
  console.error(JSON.stringify({
    event: 'outbox_worker.startup_failed',
    at: new Date().toISOString(),
    errorCode
  }));
  process.exitCode = 1;
});
