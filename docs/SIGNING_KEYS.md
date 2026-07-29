# Receipt signing-key lifecycle

Mandate-API signs receipts with Ed25519. Private keys remain outside PostgreSQL; the database stores only public verification material and lifecycle evidence.

## Invariants

- A `key_id` can never be reused with different public-key material.
- Exactly one key per tenant, environment, and algorithm is `ACTIVE`.
- Activating a new key retires the previous active key in the same transaction.
- `ACTIVE` and `RETIRED` keys remain discoverable and may verify historical receipts.
- `REVOKED` keys are excluded from normal discovery and verification.
- Live startup requires explicit persistent private/public key configuration.

## Rotation sequence

1. Generate a new Ed25519 key pair in the approved secret-management system.
2. Deploy the new private/public material with a new `MANDATE_KEY_ID`.
3. Startup registers the new public key and atomically retires the previous active key.
4. Keep retired public keys for at least the maximum receipt-retention period.
5. Revoke a key only for compromise or invalid issuance; revocation intentionally causes ordinary verification to fail.

Private key material must never be inserted into the `signing_keys` table, logs, audit events, or API responses.
