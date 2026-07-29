# Receipt verification and key discovery

Mandate-API signs action receipts with Ed25519 and identifies the signing key through the receipt's `keyId` and `algorithm` fields.

## Discovery

`GET /.well-known/mandate-keys` is unauthenticated and returns the public verification keys for the runtime tenant and environment.

The response includes:

- the current `ACTIVE` key;
- any `RETIRED` keys retained for historical receipt verification;
- the normalized SPKI PEM public key;
- a SHA-256 key fingerprint;
- activation and retirement timestamps.

`REVOKED` keys are never returned. Private key material is never stored in the registry or exposed by this endpoint.

Discovery responses use `Cache-Control: public, max-age=300`. Consumers should refresh the key set when a receipt references an unknown `keyId`, rather than assuming the receipt is permanently invalid from a stale cache.

## Verification API

`POST /v1/receipts/verify` requires the `receipts:read` scope. It resolves the receipt's own `keyId` through the signing-key registry instead of verifying only against the currently active signer.

A receipt verifies only when:

1. its signature is present;
2. its algorithm is `Ed25519`;
3. its key is `ACTIVE` or `RETIRED` for the configured tenant and environment;
4. the signature matches the canonical receipt payload.

Unknown, mismatched, unsupported, or `REVOKED` keys return `valid: false`. The endpoint does not reveal whether a failed key was unknown or revoked.

## Rotation behavior

Activating a new key atomically retires the previous active key. Existing receipts continue to verify through the retired public key. A key ID cannot be reused for different key material, and a revoked key cannot be reactivated.

See [Signing key operations](SIGNING_KEYS.md) for the runtime rotation and revocation procedure.

## Trust boundary

The registry is scoped to one tenant and one `test` or `live` environment. A public key from one scope is not used to verify a receipt in another scope. Receipt issuance still uses only the current active runtime signer; retired keys are verification-only.
