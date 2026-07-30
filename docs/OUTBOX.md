# Transactional outbox execution

## Purpose

Every security-relevant API mutation writes domain state, an immutable audit event, and an outbox message in one transaction. The outbox worker executes committed messages asynchronously without performing external I/O inside the originating API transaction.

The core remains handler-neutral. It does not register webhook, email, Slack, or connector behavior by default. A deployment starts the worker only with an explicit trusted local JavaScript module that exports exact event handlers.

## Safety rules

1. **No handler means no startup.** The standalone worker refuses an absent or empty handler module. The dispatcher itself still returns `NO_HANDLERS` when used as a library with no handlers.
2. **Handlers are exact.** Wildcard event types are rejected. A message whose event type is not registered remains `PENDING`.
3. **Handler code is local and trusted.** `MANDATE_OUTBOX_HANDLER_MODULE` must resolve to a local `file:` URL or filesystem path. Remote URL schemes are rejected.
4. **Workers are environment-partitioned.** Every worker declares exactly one `test` or `live` environment and may optionally narrow claims to one tenant.
5. **PostgreSQL is the time authority.** The standalone process obtains claim and completion timestamps from `clock_timestamp()` rather than the application host clock.
6. **Claim commits before handler I/O.** PostgreSQL leases the message and commits before the handler runs.
7. **Claims use `FOR UPDATE SKIP LOCKED`.** Multiple workers can claim different due messages without blocking one another.
8. **Stale work is prioritized.** A bounded stale-lease scan runs before the bounded pending-message scan.
9. **One exact lease owner may complete.** Completion verifies tenant, environment, message ID, worker ID, attempt number, status, and unexpired lease.
10. **Late workers cannot overwrite.** A worker returning after expiry or takeover records `LEASE_LOST`; it does not change the current message state.
11. **Stale leases are recoverable.** Reclaim records immutable `LEASE_EXPIRED` evidence before issuing the next attempt.
12. **Retries are bounded.** Handler failures return the message to `PENDING` with bounded exponential backoff until the configured maximum, then move it to `DEAD_LETTER`.
13. **Errors are sanitized.** Attempts store only an uppercase machine-safe code. Exception messages, provider bodies, secrets, and stack traces are not persisted.
14. **Attempt history is append-only.** PostgreSQL rejects update or deletion of `outbox_attempts` rows.
15. **Backlog observation is bounded.** Due, stale, and dead-letter samples are each capped by the cycle limit and use status-specific indexes.
16. **The worker has no API or migration authority.** It uses no `MANDATE_API_KEY`, checks migrations 002 and 009, and never applies migrations.

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

## Handler module contract

The deployment-owned module exports either `handlers` or a default object/Map:

```js
export const handlers = {
  'mandate.created': async (payload, message) => {
    // Perform one idempotent external side effect.
  },
  'receipt.issued': async (payload, message) => {
    // Exact event types only. No wildcard handler.
  }
};
```

Handlers must be idempotent. A lease can expire after an external side effect succeeds but before Mandate-API records completion. The outbox provides at-least-once execution, not exactly-once effects across a network boundary.

The module is trusted deployment code and receives the committed payload plus safe message metadata. It must not log secrets or raw provider responses.

## Run the worker

Apply migrations with a dedicated deployment role, then start the process separately from the API:

```bash
MANDATE_STORE=postgres \
MANDATE_ENVIRONMENT=live \
MANDATE_OUTBOX_WORKER_ID=outbox-worker-live-01 \
MANDATE_OUTBOX_HANDLER_MODULE=./deployment/outbox-handlers.js \
npm run worker:outbox
```

Relevant settings:

```text
MANDATE_OUTBOX_POLL_INTERVAL_MS=1000
MANDATE_OUTBOX_CYCLE_LIMIT=100
MANDATE_OUTBOX_LEASE_MS=30000
MANDATE_OUTBOX_MAX_ATTEMPTS=5
MANDATE_OUTBOX_BASE_DELAY_MS=1000
MANDATE_OUTBOX_MAXIMUM_DELAY_MS=60000
MANDATE_OUTBOX_READINESS_STALE_MS=5000
MANDATE_OUTBOX_READINESS_FAILURE_THRESHOLD=3
MANDATE_OUTBOX_HEALTH_HOST=127.0.0.1
MANDATE_OUTBOX_HEALTH_PORT=8789
```

The health listener is loopback-bound by default:

| Route | Purpose |
|---|---|
| `/health/live` | Process liveness |
| `/health/ready` | Recent successful-cycle readiness |
| `/metrics` | Low-cardinality Prometheus counters and capped backlog samples |

Health probes read cached state and do not query PostgreSQL per request. Binding beyond loopback requires deployment network controls.

## Operational interpretation

- `hasDue=1` after a cycle indicates more registered work may remain.
- `hasStale=1` indicates at least one expired lease remains recoverable.
- `hasDeadLetter=1` is an operator signal; the worker does not replay dead letters automatically.
- sample gauges are capped and must not be interpreted as exact global counts.
- repeated cycle failures or stale success timestamps make readiness fail closed.

## Remaining work

- controlled dead-letter inspection and replay;
- reference webhook/delivery handlers with their own idempotency contracts;
- platform-specific service manifest and restricted runtime database role;
- alert thresholds, operator runbook, and supervisor restart policy.
