import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto';
import { canonicalize } from './canonical-json.js';

export function createReceiptSigner({ privateKeyPem, publicKeyPem, keyId = 'local-dev-ed25519' } = {}) {
  let privateKey;
  let publicKey;

  if (privateKeyPem && publicKeyPem) {
    privateKey = createPrivateKey(privateKeyPem.replaceAll('\\n', '\n'));
    publicKey = createPublicKey(publicKeyPem.replaceAll('\\n', '\n'));
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  }

  return {
    keyId,
    algorithm: 'Ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signPayload(payload) {
      const bytes = Buffer.from(canonicalize(payload));
      return sign(null, bytes, privateKey).toString('base64url');
    },
    verifyPayload(payload, signature) {
      const bytes = Buffer.from(canonicalize(payload));
      return verify(null, bytes, publicKey, Buffer.from(signature, 'base64url'));
    }
  };
}
