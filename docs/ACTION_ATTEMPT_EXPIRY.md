# Action-attempt expiry process

Action-attempt reservations are deliberately short-lived. A caller cannot complete or cancel a reservation after its `expiresAt` timestamp, and the expiry process materializes that fact as the terminal `EXPIRED` state.

## Process boundary

The expiry worker runs as a dedicated process, separate from the product HTTP API:

```bash
npm run worker:attempt-expiry
```

The API does not start the worker automatically. The worker does not authenticate with `MANDATE_API_KEY`, create API credentials, expose product routes, or apply migrations.

The process uses the same PostgreSQL schema but has a narrower operational responsibility:

1. check that migration `006_attempt_completion_receipts` is already applied;
2. claim due `RESERVED` attempts;
3. change them to `EXPIRED`;
4. write system audit and outbox evidence in the same transaction;
5. inspect the remaining scoped backlog using database time;
6. publish cached liveness, readiness, and metrics for a supervisor;
7. continue polling until it receives `SIGINT` or `SIGTERM`.

Deployment must run `npm run migrate` with a separate migration role before starting the API or worker.

## Required configuration

```env
DATABASE_URL=postgresql://...
MANDATE_ENVIRONMENT=test
MANDATE_EXPIRY_WORKER_ID=expiry-worker-test-01
MANDATE_EXPIRY_POLL_INTERVAL_MS=1000
MANDATE_EXPIRY_BATCH_LIMIT=100
MANDATE_EXPIRY_READINESS_STALE_MS=5000
MANDATE_EXPIRY_READINESS_FAILURE_THRESHOLD=3
MANDATE_EXPIRY_HEALTH_HOST=127.0.0.1
MANDATE_EXPIRY_HEALTH_PORT=8788
MANDATE_DATABASE_POOL_MAX=5
MANDATE_DATABASE_SSL=false
```

`DATABASE_URL` and an explicit `test` or `live` environment are required. Live mode also requires an explicit `MANDATE_EXPIRY_WORKER_ID`. Test mode may derive a local identity from hostname and process ID.

`MANDATE_TENANT_ID` is optional. When omitted, one worker may process every tenant within the selected environment. When set, expiry and backlog metrics are restricted to that tenant.

Bounds:

- poll interval: 100–60,000 milliseconds;
- batch limit: 1–1,000 attempts per cycle;
- readiness stale window: at least two polling intervals and at most 3,600,000 milliseconds;
- readiness failure threshold: 1–100 consecutive cycles;
- health port: 1–65,535;
- database pool: 1–100 connections.

The health listener defaults to `127.0.0.1`. Binding it to a non-loopback address is an explicit deployment choice and must be protected by the platform network policy. The operational endpoints have no bearer-authentication dependency and expose no tenant IDs, credentials, action arguments, or receipt data.

## Database-time authority

PostgreSQL determines due reservations with one `clock_timestamp()` snapshot. Application-host clocks do not decide whether a live reservation has expired.

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

## Backlog observation

After each drain, one aggregate query records:

- total `RESERVED` attempts in scope;
- overdue `RESERVED` attempts;
- the oldest overdue timestamp;
- the oldest overdue age in seconds;
- the PostgreSQL observation timestamp.

The query uses the same environment and optional tenant scope as expiry processing. A host-clock value injected into a PostgreSQL worker is ignored for both expiry and backlog age.

Health probes return this cached snapshot. They do not execute a database query per request.

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
await worker.backlog();
```

`pollOnce()` expires at most one reservation and returns either `EXPIRED` or `IDLE`. `drain()` processes up to its bound and returns `limitReached`; this means the configured bound was reached, not that additional backlog was conclusively observed.

The process wrapper repeatedly calls `drain()`, refreshes the backlog snapshot, waits for the configured interval, and responds to an abort signal. A cycle failure is recorded safely and the loop continues on the next bounded interval.

If expiry transitions commit but the later backlog query fails, the committed expiry count is retained while the cycle is marked failed and readiness degrades.

## Operational HTTP surface

| Method | Route | Meaning |
|---|---|---|
| `GET`, `HEAD` | `/health/live` | The dedicated process and health listener are alive. |
| `GET`, `HEAD` | `/health/ready` | The loop has completed a recent successful cycle and has not crossed the failure threshold. |
| `GET`, `HEAD` | `/metrics` | Prometheus text metrics from cached process and backlog state. |

Other paths return `404`; mutation methods return `405`.

Readiness reasons are stable machine codes:

- `STARTING` — the loop has not completed its first fully successful cycle;
- `READY` — the last success is recent and failures are below threshold;
- `CYCLE_FAILURES` — consecutive failures reached the configured threshold;
- `STALE` — the last successful cycle is older than the configured window;
- `SHUTTING_DOWN` — graceful termination has started.

Liveness does not fail merely because PostgreSQL is temporarily unavailable. The process keeps retrying while readiness and metrics expose the degraded state.

## Metrics and structured logs

The Prometheus surface exports low-cardinality counters and gauges for:

- cycles;
- expired attempts;
- failed cycles;
- cycles that reached the batch limit;
- consecutive failures;
- reserved and overdue backlog;
- oldest overdue age;
- last backlog observation;
- last successful cycle;
- readiness.

Every cycle also emits a JSON log entry with the same cached snapshot. Lifecycle events are:

```text
action_attempt_expiry.started
action_attempt_expiry.health_started
action_attempt_expiry.cycle
action_attempt_expiry.cycle_failed
action_attempt_expiry.shutdown_requested
action_attempt_expiry.stopped
```

Failure logs persist only a safe error code, never raw database messages or connection details.

## Graceful shutdown

The executable listens for `SIGINT` and `SIGTERM`, marks readiness as `SHUTTING_DOWN`, aborts the polling loop, waits for the active cycle to finish, logs the final metrics snapshot, closes the health listener, and then closes the PostgreSQL pool.

## Remaining deployment work

The process, cached health surface, and metrics are composed and tested, but a production deployment still requires:

- a platform-specific service manifest;
- a restricted runtime database role;
- network policy for any non-loopback health binding;
- alert thresholds for consecutive failures, oldest overdue reservation, and repeated batch saturation;
- a supervisor restart policy;
- backup/restore procedures;
- an operator runbook for overdue backlog and database outages.
