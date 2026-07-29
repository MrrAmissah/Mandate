import { createPublicKey, verify } from 'node:crypto';
import { canonicalize } from './canonical-json.js';

export { canonicalize } from './canonical-json.js';

export const RECEIPT_VERIFICATION_REASONS = Object.freeze({
  VALID: 'VALID',
  INVALID_RECEIPT: 'INVALID_RECEIPT',
  UNSUPPORTED_ALGORITHM: 'UNSUPPORTED_ALGORITHM',
  KEY_NOT_FOUND: 'KEY_NOT_FOUND',
  KEY_NOT_VERIFIABLE: 'KEY_NOT_VERIFIABLE',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE'
});

function result(valid, reason, keyId = null, algorithm = null) {
  return Object.freeze({ valid, reason, keyId, algorithm });
}

function receiptParts(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const { signature, ...payload } = receipt;
  if (typeof signature !== 'string' || signature.length === 0) return null;
  if (typeof payload.keyId !== 'string' || payload.keyId.length === 0) return null;
  if (typeof payload.algorithm !== 'string' || payload.algorithm.length === 0) return null;
  return { payload, signature };
}

function keysFrom(keySet) {
  if (Array.isArray(keySet)) return keySet;
  if (keySet && typeof keySet === 'object' && Array.isArray(keySet.keys)) return keySet.keys;
  return [];
}

export function verifyMandateReceipt(receipt, keySet) {
  const parts = receiptParts(receipt);
  if (!parts) return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_RECEIPT);

  const { keyId, algorithm } = parts.payload;
  if (algorithm !== 'Ed25519') {
    return result(false, RECEIPT_VERIFICATION_REASONS.UNSUPPORTED_ALGORITHM, keyId, algorithm);
  }

  const matches = keysFrom(keySet).filter((key) => key?.keyId === keyId && key?.algorithm === algorithm);
  if (matches.length === 0) {
    return result(false, RECEIPT_VERIFICATION_REASONS.KEY_NOT_FOUND, keyId, algorithm);
  }
  if (matches.length !== 1) {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_KEY, keyId, algorithm);
  }

  const key = matches[0];
  if (!['ACTIVE', 'RETIRED'].includes(key.status)) {
    return result(false, RECEIPT_VERIFICATION_REASONS.KEY_NOT_VERIFIABLE, keyId, algorithm);
  }
  if (typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length === 0) {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_KEY, keyId, algorithm);
  }

  let publicKey;
  try {
    publicKey = createPublicKey(key.publicKeyPem.replaceAll('\\n', '\n'));
  } catch {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_KEY, keyId, algorithm);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_KEY, keyId, algorithm);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(parts.signature)) {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_SIGNATURE, keyId, algorithm);
  }
  const signature = Buffer.from(parts.signature, 'base64url');
  if (signature.length !== 64) {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_SIGNATURE, keyId, algorithm);
  }

  try {
    const valid = verify(
      null,
      Buffer.from(canonicalize(parts.payload)),
      publicKey,
      signature
    );
    return result(
      valid,
      valid ? RECEIPT_VERIFICATION_REASONS.VALID : RECEIPT_VERIFICATION_REASONS.INVALID_SIGNATURE,
      keyId,
      algorithm
    );
  } catch {
    return result(false, RECEIPT_VERIFICATION_REASONS.INVALID_SIGNATURE, keyId, algorithm);
  }
}
