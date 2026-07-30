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
17. **Dead letters are never reset in place.** Controlled replay creates a fresh pending message and an immutable source→replacement record.
18. **One replacement per source.** A dead-letter message may produce at most one direct replacement, creating a linear replay chain rather than a fork.
19. **Replay is optimistic and idempotent.** Operators must supply the observed attempt count and a payload-bound replay key.

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
DEAD_LETTER -- controlled replay --> new PENDING message
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

## Inspect dead letters

Inspection is bounded, read-only, and omits payloads, audit-event bodies, request fingerprints, and replay-key hashes:

```bash
MANDATE_ENVIRONMENT=live \
MANDATE_TENANT_ID=ten_example \
MANDATE_OUTBOX_EVENT_TYPES=receipt.issued,mandate.created \
npm run outbox:dead-letter:list
```

`MANDATE_TENANT_ID` and `MANDATE_OUTBOX_EVENT_TYPES` are optional for inspection. `MANDATE_OUTBOX_DEAD_LETTER_LIMIT` defaults to 100 and is capped at 500.

## Replay one dead letter

Replay is a deliberate operator mutation and requires every control below:

```bash
MANDATE_ENVIRONMENT=live \
MANDATE_TENANT_ID=ten_example \
MANDATE_OUTBOX_MESSAGE_ID=out_... \
MANDATE_OUTBOX_EXPECTED_ATTEMPT_COUNT=5 \
MANDATE_OPERATOR_ID=operator@example.com \
MANDATE_OUTBOX_REPLAY_REASON='Downstream outage resolved and delivery approved.' \
MANDATE_OUTBOX_REPLAY_IDEMPOTENCY_KEY='random-high-entropy-value' \
npm run outbox:dead-letter:replay
```

Replay behavior:

- locks the exact source row;
- requires `DEAD_LETTER` status and the observed attempt count;
- serializes the hashed replay key with a PostgreSQL advisory transaction lock;
- rejects key reuse with different source/operator/reason input;
- creates an immutable `outbox.dead_letter_replayed` operator audit event;
- copies the original event type, aggregate identity, and exact JSON payload into a new message;
- starts the replacement as `PENDING` with attempt count zero;
- leaves the source status, payload, timestamps, error code, and attempt history unchanged;
- permits no second direct replacement for the same source;
- permits replaying the replacement later only if that replacement itself reaches `DEAD_LETTER`.

The raw replay idempotency key is never stored. Migration 010 stores only its SHA-256 hash and the request fingerprint.

## Operational interpretation

- `hasDue=1` after a cycle indicates more registered work may remain.
- `hasStale=1` indicates at least one expired lease remains recoverable.
- `hasDeadLetter=1` is an operator signal; the worker never replays dead letters automatically.
- sample gauges are capped and must not be interpreted as exact global counts.
- repeated cycle failures or stale success timestamps make readiness fail closed.

## Remaining work

- reference webhook/delivery handlers with their own idempotency contracts;
- platform-specific service manifest and restricted runtime/operator database roles;
- alert thresholds, approval policy for live replay, and supervisor restart policy.
