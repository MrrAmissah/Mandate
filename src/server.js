import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createReceiptSigner } from './crypto/receipt-signer.js';
import { MemoryStore } from './store/memory-store.js';

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.MANDATE_API_KEY ?? 'local-development-only';
const signer = createReceiptSigner({
  privateKeyPem: process.env.MANDATE_PRIVATE_KEY_PEM,
  publicKeyPem: process.env.MANDATE_PUBLIC_KEY_PEM,
  keyId: process.env.MANDATE_KEY_ID ?? 'local-dev-ed25519'
});
const store = new MemoryStore();
const server = createServer(createApp({ store, signer, apiKey }));

server.listen(port, () => {
  console.log(`Mandate API listening on http://localhost:${port}`);
  if (apiKey === 'local-development-only') {
    console.warn('Using the local development API key. Set MANDATE_API_KEY before deployment.');
  }
});
