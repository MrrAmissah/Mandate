# Action-attempt expiry process

Action-attempt reservations are deliberately short-lived. A caller cannot complete or cancel a reservation after its `expiresAt` timestamp, and the expiry process materializes that fact as the terminal `EXPIRED` state.

## Process boundary

The expiry worker runs as a dedicated process, separate from the HTTP API:

```bash
npm run worker:attempt-expiry
```

The API does not start the worker automatically. The worker does not authenticate with `MANDATE_API_KEY`, create API credentials, or expose HTTP routes.

The process uses the same PostgreSQL schema but has a narrower operational responsibility:

1. check that migration `006_attempt_completion_receipts` is already applied;
2. claim due `RESERVED` attempts;
3. change them to `EXPIRED`;
4. write system audit and outbox evidence in the same transaction;
5. continue polling until it receives `SIGINT` or `SIGTERM`.

It never applies migrations. Deployment must run `npm run migrate` with a separate migration role before starting the API or worker.

## Required configuration

```env
DATABASE_URL=postgresql://...
MANDATE_ENVIRONMENT=test
MANDATE_EXPIRY_WORKER_ID=expiry-worker-test-01
MANDATE_EXPIRY_POLL_INTERVAL_MS=1000
MANDATE_EXPIRY_BATCH_LIMIT=100
MANDATE_DATABASE_POOL_MAX=5
MANDATE_DATABASE_SSL=false
```

`DATABASE_URL` and an explicit `test` or `live` environment are required. Live mode also requires an explicit `MANDATE_EXPIRY_WORKER_ID`. Test mode may derive a local identity from hostname and process ID.

`MANDATE_TENANT_ID` is optional. When omitted, one worker may process every tenant within the selected environment. When set, work is restricted to that tenant.

Bounds:

- poll interval: 100–60,000 milliseconds;
- batch limit: 1–1,000 attempts per cycle;
- database pool: 1–100 connections.

## Database-time authority

PostgreSQL determines due reservations with `clock_timestamp()`. Application-host clocks do not decide whether a live reservation has expired.

Each claim selects one due row using:

```sql
FOR UPDATE SKIP LOCKED
```

and atomically changes:

```text
RESERVED → EXPIRED
```

The terminal record includes:

- `terminatedAt` from PostgreSQL time;
- `terminationReason: RESERVATION_EXPIRED`;
- a system-generated termination request ID;
- an incremented optimistic version.

Several processes may poll the same environment safely. One process owns a locked reservation; another claims a different row or returns idle. Future, completed, cancelled, and already-expired attempts are never selected.

## Audit and outbox evidence

The state transition, audit event, and outbox message commit in one transaction.

```text
actorType: SYSTEM
actorId: <MANDATE_EXPIRY_WORKER_ID>
eventType: action_attempt.expired
```

The evidence includes the attempt, decision, mandate, reserving credential, original expiry timestamp, and terminal timestamp.

## Polling behavior

The lower-level worker exposes:

```js
await worker.pollOnce();
await worker.drain({ limit: 100 });
```

`pollOnce()` expires at most one reservation and returns either `EXPIRED` or `IDLE`. `drain()` processes up to its bound and returns `limitReached`; this means the configured bound was reached, not that additional backlog was conclusively observed.

The process wrapper repeatedly calls `drain()`, waits for the configured interval, and responds to an abort signal. A cycle failure is recorded safely and the loop continues on the next bounded interval.

## Structured operational counters

Every cycle emits a JSON log entry with:

- `cycles`;
- `expiredTotal`;
- `failures`;
- `consecutiveFailures`;
- `lastCycleAt`;
- `lastSuccessAt`;
- `lastErrorCode`;
- cycle `expired` count;
- `limitReached`.

Lifecycle events are:

```text
action_attempt_expiry.started
action_attempt_expiry.cycle
action_attempt_expiry.cycle_failed
action_attempt_expiry.shutdown_requested
action_attempt_expiry.stopped
```

Failure logs persist only a safe error code, never raw database messages or connection details.

## Graceful shutdown

The executable listens for `SIGINT` and `SIGTERM`, aborts the polling loop, waits for the active cycle to finish, logs the final metrics snapshot, and closes the PostgreSQL pool.

## Remaining deployment work

The process boundary is composed and tested, but a production deployment still requires:

- a platform-specific service manifest;
- a restricted runtime database role;
- external liveness/readiness supervision;
- metrics export or log-based metric extraction;
- alert thresholds for consecutive failures, oldest overdue reservation, and repeated batch saturation;
- backup/restore procedures;
- an operator runbook for overdue backlog and database outages.
