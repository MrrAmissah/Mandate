# `@mandate-api/receipt-verifier`

Offline Ed25519 verification for Mandate-API action receipts.

## Requirements

- Node.js 22 or later
- a receipt object
- the matching public key set from `/.well-known/mandate-keys`

The package performs no network requests and has no runtime dependencies.

## Usage

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

## Trust boundary

A valid result proves that the supplied public key signed the canonical receipt payload and that the payload has not changed. It does not prove the origin of the supplied key set, current mandate validity, legal authority, or the truth of facts outside the signed payload.

The caller is responsible for obtaining the key set from the correct tenant and `test` or `live` environment and refreshing cached discovery data when a receipt references an unknown key.
