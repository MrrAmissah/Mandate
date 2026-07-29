# Action attempts and execution receipts

An authorization decision answers whether an agent action was allowed at one point in time. It is not itself an endlessly reusable execution token.

Mandate-API requires a caller to reserve an `ALLOW` decision, complete or cancel that reservation, and issue a receipt only from a completed attempt.

## State machine

```text
RESERVED ──complete──> COMPLETED ──issue receipt──> signed Receipt v1.1
    │
    └──cancel───────> CANCELLED
```

An expired reservation fails completion and cancellation with `ACTION_ATTEMPT_EXPIRED`. A database-time expiry processor will later materialize the `EXPIRED` status; until then the original expiry timestamp remains authoritative.

Terminal attempts cannot transition again.

## Reserve

```http
POST /v1/action-attempts
X-Api-Key: <credential>
Idempotency-Key: <caller-generated-key>
Content-Type: application/json
```

```json
{
  "decisionId": "dec_...",
  "expiresInSeconds": 300
}
```

`expiresInSeconds` defaults to 300 and must be between 30 and 900. The credential requires `action_attempts:write`.

Reservation succeeds only when the tenant-visible decision is `ALLOW`, its mandate is active and unexpired, and the decision has neither an attempt nor a receipt. The attempt, audit event, outbox message, and idempotency response commit together.

The database locks the decision and uniquely constrains `(tenant, environment, decisionId)`, so concurrent callers produce exactly one attempt. The successful credential becomes `reservedByCredentialId` and owns terminal control of that attempt.

## Complete

```http
POST /v1/action-attempts/{att_id}/complete
```

```json
{
  "executionStatus": "SUCCEEDED",
  "inputHash": "sha256:<64 lowercase hex characters>",
  "outputHash": "sha256:<64 lowercase hex characters>",
  "tool": "github.create_commit",
  "provider": "github",
  "model": null
}
```

`executionStatus` is `SUCCEEDED`, `FAILED`, or `PARTIAL`. Completion stores the exact hashes, tool identity, optional provider/model, completion timestamp, request ID, and new version.

Completion is allowed only while the attempt is `RESERVED`, before `expiresAt`, and when the authenticated credential matches `reservedByCredentialId`. Replaying the same idempotency key returns the original completed attempt. A different request cannot overwrite terminal evidence.

## Cancel

```http
POST /v1/action-attempts/{att_id}/cancel
```

```json
{
  "reason": "Caller abandoned the operation"
}
```

Cancellation is allowed only for an unexpired `RESERVED` attempt and only by the credential that reserved it. It stores the reason, termination timestamp, and request ID. A cancelled attempt cannot complete or produce a receipt.

A different credential in the same tenant receives `403 ACTION_ATTEMPT_OWNER_MISMATCH`; broad tenant scopes do not grant control over another credential's reservation.

## Issue the receipt

```http
POST /v1/receipts
```

```json
{
  "actionAttemptId": "att_..."
}
```

Receipt issuance requires `receipts:write` and a `COMPLETED` attempt. The server loads the immutable decision and mandate, copies the stored completion evidence, signs the canonical payload, and writes exactly one receipt for both the attempt and decision.

Attempt-bound receipts use schema version `1.1` and include `actionAttemptId`. Their `executedAt` is the attempt's `completedAt`, not the later signature time.

A mandate revoked after completion does not prevent issuing evidence of the already completed action. Revocation blocks new reservations; it does not erase history.

Concurrent receipt issuers produce one receipt. Reusing another idempotency key returns `RECEIPT_ALREADY_EXISTS` rather than signing a second record.

## Read attempts

```http
GET /v1/action-attempts
GET /v1/action-attempts/{att_id}
```

These routes require `action_attempts:read` and use the standard cursor pagination conventions. Cross-tenant access is indistinguishable from a missing resource.

## Events

The append-only event catalogue now includes:

```text
action_attempt.reserved
action_attempt.completed
action_attempt.cancelled
receipt.issued
```

Each transition writes its state, audit event, outbox message, and idempotency response in one transaction.

## Remaining lifecycle work

- database-time expiry materialization;
- a composed expiry worker;
- operator recovery for dead-letter events;
- receipt supersession/correction without rewriting signed history;
- offline verification package.
