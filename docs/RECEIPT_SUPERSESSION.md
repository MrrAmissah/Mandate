# Append-only receipt supersession

Receipt supersession corrects or reissues a signed execution receipt without changing signed history.

It is not an update operation. The predecessor remains immutable and independently verifiable. The API appends one new Ed25519-signed receipt that points directly to the predecessor.

## Route

```http
POST /v1/receipts/{receiptId}/supersede
X-Api-Key: <credential>
Idempotency-Key: <caller-generated-key>
Content-Type: application/json
```

```json
{
  "reason": "Reissue under the current signing key."
}
```

The credential requires `receipts:write`. `reason` is trimmed, required, and limited to 1,000 Unicode characters.

A successful request returns `201` with receipt schema version `1.2`.

## Signed successor fields

A v1.2 successor adds two signed fields:

- `supersedesReceiptId` — the direct predecessor receipt ID;
- `supersessionReason` — the bounded caller-supplied reason.

The successor receives a new `id`, `issuedAt`, `keyId`, `algorithm`, and signature. It copies the predecessor's execution identity and evidence exactly:

- decision, mandate, and action-attempt IDs;
- principal and agent IDs;
- action and resource;
- execution status;
- input and output hashes;
- tool, provider, and model;
- approval and authorization timestamp;
- execution timestamp.

Callers cannot supply replacement hashes, status, tool metadata, action, resource, or execution time.

## Linear-chain invariant

Each receipt may have at most one direct successor:

```text
Receipt v1.1 ──supersede──> Receipt v1.2 ──supersede──> Receipt v1.2
```

Forks are rejected. A later correction supersedes the current chain tip rather than creating another child of an earlier receipt.

PostgreSQL enforces this with:

- one root receipt per decision and action attempt;
- one successor per predecessor;
- a composite foreign key requiring every successor to retain the predecessor's decision and action-attempt identity;
- check constraints binding indexed chain columns to the signed JSON payload;
- immutable receipt rows;
- an exclusive predecessor-row lock and a unique-index final arbiter for concurrent requests.

## Verification and signing requirements

The predecessor must verify through the tenant and environment's signing-key registry before a successor is signed.

- `ACTIVE` and `RETIRED` predecessor keys are accepted;
- `REVOKED`, unknown, malformed, or tampered predecessors fail closed;
- the successor signer must match the exact scoped key record and that key must still be `ACTIVE`;
- in PostgreSQL mode the predecessor verification key and current successor key are held with shared transaction locks until commit, while the predecessor receipt is held with an exclusive row lock.

Those locks prevent key rotation or revocation from passing either trust check between verification and durable successor creation. A stale, retired, revoked, mismatched, or unregistered runtime signer returns `503 SIGNING_KEY_NOT_ACTIVE` and no receipt is committed.

## Idempotency and events

The route is payload-bound and idempotent under the scope `supersede-receipt:{receiptId}`.

- an exact retry returns the original successor;
- reusing the same key with a different reason returns `IDEMPOTENCY_CONFLICT`;
- a different key after a successor already exists returns `RECEIPT_ALREADY_SUPERSEDED` and identifies the existing successor;
- the successor, audit event, outbox message, and idempotency response commit together;
- migration downgrade removes supersession replay records before deleting successor receipts, preventing stale responses from surviving a downgrade and reapply.

The append-only event type is `receipt.superseded`.

## Stable failures

| Code | Meaning |
|---|---|
| `RECEIPT_NOT_FOUND` | The tenant-visible predecessor does not exist. |
| `RECEIPT_NOT_VERIFIABLE` | The predecessor signature or scoped key status is not trusted. |
| `RECEIPT_NOT_SUPERSEDABLE` | The predecessor is not an attempt-bound v1.1 or v1.2 execution receipt. |
| `RECEIPT_ALREADY_SUPERSEDED` | The predecessor already has its one direct successor. |
| `SIGNING_KEY_NOT_ACTIVE` | The configured successor signer is not the active scoped key. |
| `INVALID_REQUEST` | The request or reason is malformed or out of bounds. |
| `IDEMPOTENCY_CONFLICT` | The idempotency key was reused with different input. |

## Trust boundary

Supersession proves that Mandate-API appended a new signed statement preserving the predecessor's recorded execution evidence. It does not erase the predecessor, retroactively change authorization, prove an external side effect, or make false source evidence true.

When a predecessor key is revoked because its historical signatures are no longer trustworthy, automatic supersession is intentionally blocked. Any recovery process for compromised-key history requires a separate operator and evidence policy rather than silently re-signing untrusted data.
