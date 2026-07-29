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

Unknown, mismatched, unsupported, or `REVOKED` keys return `valid: false`. The endpoint deliberately does not reveal whether a failed key was unknown or revoked.

## Offline Node.js and TypeScript verifier

The zero-dependency package under `packages/receipt-verifier` verifies a receipt without calling Mandate-API:

```js
import { verifyMandateReceipt } from '@mandate-api/receipt-verifier';

const result = verifyMandateReceipt(receipt, discoveryResponse);

if (!result.valid) {
  console.error(result.reason);
}
```

It accepts either the complete discovery response (`{ keys: [...] }`) or a raw key array. It performs no network requests, stores no key material, and requires only public SPKI PEM keys.

Stable result reasons are:

| Reason | Meaning |
|---|---|
| `VALID` | An active or retired Ed25519 key verified the canonical payload. |
| `INVALID_RECEIPT` | Required signature metadata is missing or the input is not an object. |
| `UNSUPPORTED_ALGORITHM` | The receipt does not declare `Ed25519`. |
| `KEY_NOT_FOUND` | No exact `keyId` and algorithm pair exists in the supplied key set. |
| `KEY_NOT_VERIFIABLE` | The exact key exists but is not `ACTIVE` or `RETIRED`. |
| `KEY_SET_UNAVAILABLE` | A scope-bound cache could not obtain a current key set. |
| `INVALID_KEY` | Key material is malformed, ambiguous, or not Ed25519. |
| `INVALID_SIGNATURE` | The signature is malformed or does not match the payload. |

The package ships TypeScript declarations but executes as Node.js ESM on Node 22 or later.

## Scope-bound key-set cache

The package also exposes `createMandateKeySetCache`. The cache accepts an injected loader rather than embedding HTTP:

```js
import { createMandateKeySetCache } from '@mandate-api/receipt-verifier';

const cache = createMandateKeySetCache({
  scopeId: 'tenant-123:live',
  maxAgeMs: 300_000,
  async load() {
    const response = await fetch('https://mandate.example/.well-known/mandate-keys');
    if (!response.ok) throw new Error('discovery failed');
    return response.json();
  }
});

const result = await cache.verify(receipt);
```

The application defines and enforces the meaning of `scopeId`. One cache instance must never be shared between tenants or between `test` and `live` environments.

Cache invariants:

1. concurrent refreshes share one loader call;
2. the cache lifetime begins after loading completes;
3. expired key data is never used when a refresh fails;
4. malformed receipts and unsupported algorithms fail without calling the loader;
5. an unknown key triggers one forced refresh only when verification first used an already cached key set;
6. invalidation prevents an older in-flight refresh from repopulating the cache;
7. loader errors return `KEY_SET_UNAVAILABLE` and do not expose transport details;
8. cached keys are cloned and frozen before use.

The default lifetime is five minutes, matching the current discovery `max-age`. Applications may set a stricter value but should not exceed their security policy or the server's advertised cache lifetime.

## Canonicalization parity

The server's historical import path re-exports canonical JSON from the verifier package. Receipt issuance, server verification, and offline verification therefore use one implementation rather than three copied algorithms.

The conformance fixture at `test/fixtures/receipt-verification/ed25519-v1.1.json` contains:

- one public Ed25519 key;
- one signed receipt v1.1;
- the exact canonical payload string;
- no private key.

The tamper corpus changes independently signed fields and proves that both the offline verifier and an independent server-style verifier reject every mutation.

## Rotation behavior

Activating a new key atomically retires the previous active key. Existing receipts continue to verify through the retired public key. A key ID cannot be reused for different key material, and a revoked key cannot be reactivated.

Offline callers are responsible for obtaining the correct tenant/environment key set and refreshing it according to the discovery cache policy. The verifier does not infer scope from a receipt or select a discovery endpoint.

See [Signing key operations](SIGNING_KEYS.md) for the runtime rotation and revocation procedure.

## Trust boundary

The registry is scoped to one tenant and one `test` or `live` environment. A public key from one scope is not used by the server to verify a receipt in another scope. Receipt issuance uses only the current active runtime signer; retired keys are verification-only.

A valid signature proves that the receipt payload has not changed and that a supplied verifiable key signed it. It does **not** independently prove current mandate validity, legal authority, successful external side effects, or the truth of data outside the signed payload. Consumers must apply their own trust policy to the key-set origin, environment, receipt version, and business context.
