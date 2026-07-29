import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createStaticApiKeyAuthenticator } from './auth/authentication.js';
import { createReceiptSigner } from './crypto/receipt-signer.js';
import { MemoryStore } from './store/memory-store.js';

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.MANDATE_API_KEY ?? 'local-development-only';
const tenantId = process.env.MANDATE_TENANT_ID ?? 'ten_local';
const environment = process.env.MANDATE_ENVIRONMENT ?? 'test';
const scopes = (process.env.MANDATE_API_SCOPES ?? '*')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);

if (environment === 'live' && apiKey === 'local-development-only') {
  throw new Error('MANDATE_API_KEY must be configured before starting a live environment.');
}

const signer = createReceiptSigner({
  privateKeyPem: process.env.MANDATE_PRIVATE_KEY_PEM,
  publicKeyPem: process.env.MANDATE_PUBLIC_KEY_PEM,
  keyId: process.env.MANDATE_KEY_ID ?? 'local-dev-ed25519'
});
const store = new MemoryStore({ tenantId, environment });
const authenticator = createStaticApiKeyAuthenticator({
  apiKey,
  tenantId,
  environment,
  credentialId: 'key_runtime',
  scopes
});
const server = createServer(createApp({ store, signer, authenticator }));

server.listen(port, () => {
  console.log(`Mandate-API listening on http://localhost:${port}`);
  console.warn('The runtime is using the in-memory reference store. It is not restart-safe.');
  if (apiKey === 'local-development-only') {
    console.warn('Using the local development API key. Set MANDATE_API_KEY before deployment.');
  }
});
