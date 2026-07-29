# Transactional outbox execution

## Purpose

Every security-relevant API mutation already writes domain state, an immutable audit event, and an outbox message in one transaction. The outbox worker executes those committed messages asynchronously without performing external I/O inside the originating API transaction.

This phase provides the execution substrate only. It does not register webhook, email, Slack, or connector handlers by default.

## Safety rules

1. **No handler means no claim.** A dispatcher with no handlers returns `NO_HANDLERS`. A message whose exact event type is not registered remains `PENDING`.
2. **Workers are environment-partitioned.** Every dispatcher declares exactly one `test` or `live` environment. It may optionally narrow claims to one tenant. A test worker cannot claim a live message.
3. **Claim commits before handler I/O.** PostgreSQL leases the message and commits before the handler runs.
4. **Claims use `FOR UPDATE SKIP LOCKED`.** Multiple workers can claim different due messages without blocking one another.
5. **One exact lease owner may complete.** Completion verifies tenant, environment, message ID, worker ID, attempt number, status, and unexpired lease.
6. **Late workers cannot overwrite.** A worker returning after expiry or takeover records `LEASE_LOST`; it does not change the current message state.
7. **Stale leases are recoverable.** Reclaim records immutable `LEASE_EXPIRED` evidence before issuing the next attempt.
8. **Retries are bounded.** Handler failures return the message to `PENDING` with bounded exponential backoff until the configured maximum, then move it to `DEAD_LETTER`.
9. **Errors are sanitized.** Attempts store only an uppercase machine-safe code. Exception messages, provider bodies, secrets, and stack traces are not persisted.
10. **Attempt history is append-only.** PostgreSQL rejects update or deletion of `outbox_attempts` rows.
11. **Event types are exact.** There is no wildcard or catch-all handler in the core dispatcher.

## Message lifecycle

```text
PENDING
   |
   | claim due message
   v
PROCESSING -- handler succeeds --> PROCESSED
   |
   | handler fails below attempt limit
   v
PENDING (future available_at)
   |
   | handler fails at limit or stale final attempt
   v
DEAD_LETTER
```

A stale `PROCESSING` lease may be reclaimed. The prior attempt receives `LEASE_EXPIRED`; the new worker receives the next attempt number.

## Attempt outcomes

| Outcome | Meaning |
|---|---|
| `SUCCEEDED` | The owning worker completed the handler and marked the message processed. |
| `FAILED` | The handler failed and a retry was scheduled. |
| `DEAD_LETTER` | The retry limit was exhausted. |
| `LEASE_EXPIRED` | A later worker recovered an expired processing lease. |
| `LEASE_LOST` | A previous worker returned after it no longer owned the attempt. |

More than one evidence outcome may reference one attempt number. For example, a stale attempt can receive `LEASE_EXPIRED` when recovered and later `LEASE_LOST` when its original worker returns.

## Dispatcher API

```js
const dispatcher = new OutboxDispatcher({
  queue,
  workerId: 'worker_test_01',
  scope: {
    environment: 'test',
    tenantId: 'ten_example' // Optional: omit for all tenants in test.
  },
  handlers: {
    'mandate.created': async (payload, message) => {
      // Perform one idempotent external side effect.
    }
  }
});

await dispatcher.pollOnce();
```

Handlers must be idempotent because a lease can expire after an external side effect succeeds but before Mandate-API records completion. The outbox provides at-least-once execution, not exactly-once effects across a network boundary.

## Deliberate remaining work

- no continuously running worker process is started by the API;
- no webhook delivery handler exists yet;
- no dead-letter replay or administrative endpoint exists;
- no metrics, alert thresholds, or operator runbook exists;
- handler-specific idempotency contracts remain the responsibility of each later adapter;
- database-time enforcement and production clock-skew policy remain deployment-hardening concerns.
