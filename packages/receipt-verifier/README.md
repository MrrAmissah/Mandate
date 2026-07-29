# `@mandate-api/receipt-verifier`

Offline Ed25519 verification and strict public-key caching for Mandate-API action receipts.

## Requirements

- Node.js 22 or later
- a receipt object
- the matching public key set from `/.well-known/mandate-keys`

The package has no runtime dependencies. The core verifier performs no network requests.

## Verify with an existing key set

```js
import { verifyMandateReceipt } from '@mandate-api/receipt-verifier';

const result = verifyMandateReceipt(receipt, discoveryResponse);

if (result.valid) {
  console.log('Receipt signature is valid.');
} else {
  console.error(result.reason);
}
```

The second argument may be the complete discovery response or its `keys` array.

Active and retired Ed25519 keys may verify historical receipts. Revoked, unknown, malformed, ambiguous, and non-Ed25519 keys fail closed with a stable reason code.

## Verify through a scope-bound cache

The package does not embed HTTP. Supply a loader that obtains the discovery response for exactly one tenant/environment scope:

```js
import { createMandateKeySetCache } from '@mandate-api/receipt-verifier';

const cache = createMandateKeySetCache({
  scopeId: 'tenant-123:live',
  maxAgeMs: 300_000,
  async load() {
    const response = await fetch('https://mandate.example/.well-known/mandate-keys');
    if (!response.ok) throw new Error('key discovery failed');
    return response.json();
  }
});

const result = await cache.verify(receipt);
```

Cache rules:

- one cache instance belongs permanently to one caller-defined `scopeId`;
- concurrent ordinary and unknown-key refreshes share one loader operation and result;
- freshness begins when loading completes;
- expired data is never used when refresh fails;
- malformed receipts and unsupported algorithms fail before the loader runs;
- unknown-key discovery is attempted at most once per cached generation, including across random key IDs;
- a missing or failed unknown-key refresh suppresses repeated loader traffic until the cache genuinely advances or is invalidated;
- `invalidate()` prevents an in-flight older refresh from repopulating the cache;
- loader errors become `KEY_SET_UNAVAILABLE` without exposing transport details;
- cached key objects are cloned and frozen before use.

The loader receives `{ scopeId }`, but the package neither interprets that value nor chooses an endpoint. The application must prevent one cache instance from being reused across tenants or `test`/`live` environments.

## Trust boundary

A valid result proves that the supplied public key signed the canonical receipt payload and that the payload has not changed. It does not prove the origin of the supplied key set, current mandate validity, legal authority, or the truth of facts outside the signed payload.

The caller is responsible for obtaining the key set from the correct tenant and environment, authenticating the discovery origin, and choosing an appropriate cache lifetime. The default five-minute lifetime matches the current discovery response cache policy.
