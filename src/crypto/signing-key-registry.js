import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalize } from './canonical-json.js';

const STATUS = Object.freeze({ ACTIVE: 'ACTIVE', RETIRED: 'RETIRED', REVOKED: 'REVOKED' });
const RETRYABLE_DATABASE_CODES = new Set(['40001', '40P01', '23505']);

function normalizePublicKey(publicKeyPem) {
  const key = createPublicKey(publicKeyPem.replaceAll('\\n', '\n'));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Only Ed25519 public keys are supported.');
  }
  const pem = key.export({ type: 'spki', format: 'pem' }).toString();
  const der = key.export({ type: 'spki', format: 'der' });
  const fingerprint = `sha256:${createHash('sha256').update(der).digest('hex')}`;
  return { key, pem, fingerprint };
}

function safePublicKeyFingerprint(publicKeyPem) {
  try {
    return normalizePublicKey(publicKeyPem).fingerprint;
  } catch {
    return null;
  }
}

function validateKeyId(keyId) {
  if (typeof keyId !== 'string' || !/^key_[A-Za-z0-9_-]{3,120}$/.test(keyId)) {
    throw new TypeError('Signing key IDs must use the key_ prefix and contain only safe characters.');
  }
  return keyId;
}

function rowToKey(row) {
  return row && {
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicKeyPem: row.public_key_pem,
    fingerprint: row.fingerprint,
    status: row.status,
    activatedAt: new Date(row.activated_at).toISOString(),
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revocationReason: row.revocation_reason ?? null
  };
}

function retryDelayMilliseconds(attempt) {
  return Math.min(10 * (2 ** (attempt - 1)), 100);
}

async function defaultRetryDelay(attempt) {
  await new Promise((resolve) => setTimeout(resolve, retryDelayMilliseconds(attempt)));
}

export class PostgresSigningKeyRegistry {
  constructor(pool, ownership, { maximumTransactionAttempts = 4, retryDelay = defaultRetryDelay } = {}) {
    if (!Number.isInteger(maximumTransactionAttempts) || maximumTransactionAttempts < 1) {
      throw new TypeError('maximumTransactionAttempts must be a positive integer.');
    }
    if (typeof retryDelay !== 'function') throw new TypeError('retryDelay must be a function.');
    this.pool = pool;
    this.ownership = ownership;
    this.maximumTransactionAttempts = maximumTransactionAttempts;
    this.retryDelay = retryDelay;
  }

  async registerActive({ keyId, algorithm = 'Ed25519', publicKeyPem, activatedAt = new Date() }) {
    validateKeyId(keyId);
    if (algorithm !== 'Ed25519') throw new TypeError('Only Ed25519 signing keys are supported.');
    const normalized = normalizePublicKey(publicKeyPem);

    for (let attempt = 1; attempt <= this.maximumTransactionAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const existing = await client.query(
          `SELECT * FROM mandate.signing_keys
           WHERE tenant_id = $1 AND environment = $2 AND key_id = $3
           FOR UPDATE`,
          [this.ownership.tenantId, this.ownership.environment, keyId]
        );
        if (existing.rowCount > 0 && existing.rows[0].fingerprint !== normalized.fingerprint) {
          throw new Error('SIGNING_KEY_ID_REUSE');
        }
        if (existing.rowCount > 0 && existing.rows[0].status === STATUS.REVOKED) {
          throw new Error('SIGNING_KEY_REVOKED');
        }

        await client.query(
          `UPDATE mandate.signing_keys
           SET status = 'RETIRED', retired_at = COALESCE(retired_at, $4::timestamptz)
           WHERE tenant_id = $1 AND environment = $2 AND algorithm = $3
             AND status = 'ACTIVE' AND key_id <> $5`,
          [this.ownership.tenantId, this.ownership.environment, algorithm, activatedAt.toISOString(), keyId]
        );

        const result = await client.query(
          `INSERT INTO mandate.signing_keys
            (tenant_id, environment, key_id, algorithm, public_key_pem, fingerprint, status, activated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7)
           ON CONFLICT (tenant_id, environment, key_id) DO UPDATE SET
             status = 'ACTIVE', retired_at = NULL
           RETURNING *`,
          [this.ownership.tenantId, this.ownership.environment, keyId, algorithm,
            normalized.pem, normalized.fingerprint, activatedAt.toISOString()]
        );
        await client.query('COMMIT');
        return rowToKey(result.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (RETRYABLE_DATABASE_CODES.has(error.code) && attempt < this.maximumTransactionAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }

    throw new Error('Signing-key registration exhausted its transaction attempts.');
  }

  async listDiscoverable() {
    const result = await this.pool.query(
      `SELECT * FROM mandate.signing_keys
       WHERE tenant_id = $1 AND environment = $2 AND status IN ('ACTIVE','RETIRED')
       ORDER BY activated_at DESC, key_id`,
      [this.ownership.tenantId, this.ownership.environment]
    );
    return result.rows.map(rowToKey);
  }

  async verifyActiveSigner({
    keyId,
    algorithm,
    publicKeyPem,
    queryable = this.pool,
    lock = false
  }) {
    if (algorithm !== 'Ed25519' || !queryable || typeof queryable.query !== 'function') return false;
    const fingerprint = safePublicKeyFingerprint(publicKeyPem);
    if (!fingerprint) return false;
    const lockClause = lock ? ' FOR SHARE' : '';
    const result = await queryable.query(
      `SELECT fingerprint FROM mandate.signing_keys
       WHERE tenant_id = $1 AND environment = $2 AND key_id = $3
         AND algorithm = $4 AND status = 'ACTIVE'${lockClause}`,
      [this.ownership.tenantId, this.ownership.environment, keyId, algorithm]
    );
    return result.rowCount === 1 && result.rows[0].fingerprint === fingerprint;
  }

  async verifyPayload({
    keyId,
    algorithm,
    payload,
    signature,
    queryable = this.pool,
    lock = false
  }) {
    if (algorithm !== 'Ed25519' || typeof signature !== 'string') return false;
    if (!queryable || typeof queryable.query !== 'function') return false;
    const lockClause = lock ? ' FOR SHARE' : '';
    const result = await queryable.query(
      `SELECT public_key_pem FROM mandate.signing_keys
       WHERE tenant_id = $1 AND environment = $2 AND key_id = $3
         AND algorithm = $4 AND status IN ('ACTIVE','RETIRED')${lockClause}`,
      [this.ownership.tenantId, this.ownership.environment, keyId, algorithm]
    );
    if (result.rowCount !== 1) return false;
    const publicKey = createPublicKey(result.rows[0].public_key_pem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(canonicalize(payload)), publicKey, Buffer.from(signature, 'base64url'));
  }

  async revoke(keyId, reason, revokedAt = new Date()) {
    validateKeyId(keyId);
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new TypeError('A signing-key revocation reason is required.');
    }
    const result = await this.pool.query(
      `UPDATE mandate.signing_keys
       SET status = 'REVOKED', revoked_at = $4, revocation_reason = $5
       WHERE tenant_id = $1 AND environment = $2 AND key_id = $3 AND status <> 'REVOKED'
       RETURNING *`,
      [this.ownership.tenantId, this.ownership.environment, keyId, revokedAt.toISOString(), reason.trim()]
    );
    return rowToKey(result.rows[0]);
  }
}

export function createStaticSigningKeyRegistry(signer) {
  const key = {
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    publicKeyPem: signer.publicKeyPem,
    fingerprint: normalizePublicKey(signer.publicKeyPem).fingerprint,
    status: STATUS.ACTIVE,
    activatedAt: null,
    retiredAt: null,
    revokedAt: null,
    revocationReason: null
  };
  return {
    async registerActive(candidate) {
      if (candidate.keyId !== key.keyId || normalizePublicKey(candidate.publicKeyPem).fingerprint !== key.fingerprint) {
        throw new Error('STATIC_SIGNING_KEY_MISMATCH');
      }
      return structuredClone(key);
    },
    async listDiscoverable() { return [structuredClone(key)]; },
    async verifyActiveSigner({ keyId, algorithm, publicKeyPem }) {
      return keyId === key.keyId
        && algorithm === key.algorithm
        && safePublicKeyFingerprint(publicKeyPem) === key.fingerprint;
    },
    async verifyPayload({ keyId, algorithm, payload, signature }) {
      if (keyId !== key.keyId || algorithm !== key.algorithm) return false;
      return signer.verifyPayload(payload, signature);
    }
  };
}
