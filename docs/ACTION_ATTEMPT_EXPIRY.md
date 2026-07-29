# Action-attempt expiry worker

Action-attempt reservations are deliberately short-lived. A caller cannot complete or cancel a reservation after its `expiresAt` timestamp, and the expiry worker materializes that fact as the terminal `EXPIRED` state.

## Trust boundary

The worker is a library component. The API process does not start it automatically. A deployment may run one or more dedicated worker processes with an explicit environment and optional tenant scope.

```js
const worker = new ActionAttemptExpiryWorker({
  store,
  workerId: 'expiry-worker-live-01',
  scope: { environment: 'live' }
});

await worker.pollOnce();
```

A tenant-scoped worker may additionally set `tenantId`.

## Database-time authority

PostgreSQL workers determine due reservations with `clock_timestamp()`. Application host clocks do not decide whether a live reservation has expired.

The worker selects one due row using:

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

## Multi-worker behavior

Several workers may poll the same environment safely. Row locks and `SKIP LOCKED` ensure one worker owns a due reservation, while another worker either claims a different reservation or returns `IDLE`.

A worker cannot expire:

- a future reservation;
- a completed attempt;
- a cancelled attempt; or
- an already expired attempt.

## Audit and outbox evidence

The state transition, audit event, and outbox message commit in the same transaction.

The audit actor is:

```text
actorType: SYSTEM
actorId: <workerId>
```

The emitted event is:

```text
action_attempt.expired
```

It records the attempt, decision, mandate, reserving credential, original expiry timestamp, and terminal timestamp.

## Polling APIs

`pollOnce()` expires at most one reservation and returns:

```js
{ status: 'EXPIRED', ownership, actionAttempt }
```

or:

```js
{ status: 'IDLE' }
```

`drain({ limit })` repeatedly polls up to the configured bound and returns the expired attempts. The accepted limit is 1–1000.

## Operational boundary

Still required before production:

- a composed worker executable and deployment manifest;
- polling cadence and shutdown behavior;
- metrics for due backlog, expiry throughput, failures, and oldest overdue reservation;
- alert thresholds and runbooks;
- database availability and retry policy at the process boundary;
- health/readiness reporting.
