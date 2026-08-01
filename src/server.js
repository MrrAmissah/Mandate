import { createServer } from 'node:http';
import { createServerHandler } from './http/server-handler.js';
import { createRuntime } from './runtime.js';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const runtime = await createRuntime();
const server = createServer(createServerHandler(runtime));
let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  runtime.health.beginShutdown();
  console.log(`Received ${signal}; shutting down Mandate-API.`);
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

server.listen(port, () => {
  console.log(`Mandate-API listening on http://localhost:${port}`);
  console.log(`Persistence mode: ${runtime.mode}`);
  if (runtime.mode === 'memory') {
    console.warn('The in-memory reference store is not restart-safe.');
  }
  if ((process.env.MANDATE_API_KEY ?? 'local-development-only') === 'local-development-only') {
    console.warn('Using the local development API key. Set MANDATE_API_KEY before deployment.');
  }
});
