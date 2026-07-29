# Action attempts and decision reservations

An authorization decision answers whether an agent action was allowed at one point in time. It is not itself an endlessly reusable execution token.

Mandate-API therefore requires a caller to reserve an `ALLOW` decision before the protected tool executes.

## Resource

An action attempt has an opaque `att_` ID and records:

- the exact authorization decision;
- the underlying mandate;
- agent, action, and resource copied from the immutable decision;
- the API credential that reserved execution;
- reservation and expiry timestamps;
- the originating request ID;
- the attempt status and version.

Initial status is `RESERVED`. Future phases will add controlled transitions to `COMPLETED`, `CANCELLED`, or `EXPIRED` and bind receipt issuance to terminal attempt completion.

## Reserve an attempt

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

`expiresInSeconds` defaults to 300 and must be between 30 and 900.

The credential requires `action_attempts:write`.

A reservation succeeds only when:

1. the decision belongs to the authenticated tenant and environment;
2. the decision outcome is `ALLOW`;
3. the underlying mandate still exists, remains active, and has not expired;
4. the decision has no existing action attempt; and
5. the decision has no execution receipt.

A successful reservation returns `201` and atomically writes the attempt, audit event, outbox message, and idempotency record.

## Exactly-once reservation

The database places a unique constraint on `(tenant, environment, decisionId)`. The reservation transaction also locks the decision row before checking existing attempts.

Two callers racing to reserve the same decision therefore produce exactly one successful action attempt. The other request returns `409 ACTION_ATTEMPT_ALREADY_RESERVED`. Replaying the same request with the same idempotency key returns the original attempt.

A different idempotency key does not create a second attempt.

## Read attempts

```http
GET /v1/action-attempts
GET /v1/action-attempts/{att_id}
```

These routes require `action_attempts:read`. Collection reads use the standard `limit` and `startingAfter` pagination conventions.

Cross-tenant access is indistinguishable from a missing resource.

## Security meaning

`RESERVED` means only that the caller acquired the one execution slot represented by an authorization decision. It does **not** mean:

- the tool started;
- the tool completed;
- the output was accepted;
- a receipt exists; or
- the action succeeded.

The reservation expires to limit how long an authorization can remain outstanding. Phase 3B will add completion/cancellation transitions and require a completed attempt before a signed receipt can be issued.

## Events

Reservation emits the append-only event:

```text
action_attempt.reserved
```

The corresponding audit and outbox records include the attempt ID, decision ID, mandate ID, request ID, and reservation expiry.
