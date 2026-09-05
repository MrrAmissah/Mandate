# Production supervision and operations contract

This document defines Mandate's deployment-neutral supervision baseline for the API, action-attempt expiry worker, outbox worker, one-shot maintenance commands, and PostgreSQL recovery operations. It describes what the repository can enforce or test without choosing a cloud provider.

It is **not** a high-availability claim, an infrastructure sizing study, or a substitute for a provider-specific firewall, load balancer, backup service, paging system, or disaster-recovery plan.

## 1. Supervision boundary

The reference topology in `deployment/compose.production.yaml` separates process authority and process lifetime:

| Process | Lifetime | Restart posture | Failure meaning |
|---|---|---|---|
| API | long-running | `unless-stopped` | stop routing while readiness fails; restart only when the process itself exits or liveness supervision determines it is wedged |
| action-attempt expiry | long-running | `unless-stopped` | expiry materialization is delayed; authorization expiry itself is still determined by PostgreSQL time and completion remains fail-closed |
| outbox | long-running | `unless-stopped` | event delivery is delayed; leased work is recovered after lease expiry |
| migration | one-shot | never auto-restart | operator must inspect and deliberately rerun |
| database-role configuration | one-shot | never auto-restart | runtime roles may intentionally remain quiesced; operator must correct and deliberately rerun |
| idempotency cleanup | one-shot | scheduler/operator controlled | retained rows remain longer; replay safety is not shortened |
| dead-letter inspection/replay | one-shot | operator controlled | no automatic replay is permitted |
| backup/restore drill | one-shot | operator/scheduler controlled | recovery evidence is unavailable until a successful run |

A readiness failure is **not** itself permission to terminate a process. Readiness removes traffic or raises an operational signal. Liveness is the process-level restart signal. This distinction prevents a transient PostgreSQL outage from creating a restart storm while the workers are already designed to retry bounded cycles.

## 2. Shutdown contract

Long-running services receive `SIGTERM` and have a 30-second supervisor grace period in the reference Compose topology.

The expiry and outbox executables:

1. record `shutdown_requested` once;
2. abort the polling loop;
3. stop advertising readiness;
4. let the active bounded cycle finish;
5. close their health listener;
6. close the PostgreSQL pool.

The API readiness path also fails closed while shutdown is in progress.

If infrastructure force-kills a worker after the grace period, durable work is not reassigned by memory state. PostgreSQL leases and stale-lease recovery remain the authority. Operators must investigate repeated forced shutdowns rather than reducing the grace period until the symptom disappears.

## 3. Resource and log bounds

The reference Compose contract applies the following defaults to every service unless the deployment deliberately overrides them:

| Control | Default | Purpose |
|---|---:|---|
| CPU | `1.0` CPU | stop one process from consuming an unbounded host share |
| memory | `512m` | give the supervisor an explicit memory ceiling |
| PIDs | `256` | bound process/thread fan-out |
| writable temporary storage | `64m` tmpfs | bound the only normal writable filesystem area |
| log file | `10m` | bound one JSON log segment |
| retained log files | `5` | bound local Docker log retention |
| stop grace | `30s` | permit bounded in-flight shutdown |

Overrides are deployment inputs:

```text
MANDATE_SERVICE_CPUS
MANDATE_SERVICE_MEMORY_LIMIT
MANDATE_LOG_MAX_SIZE
MANDATE_LOG_MAX_FILES
```

These values are **starting safety budgets, not measured capacity recommendations**. Load testing must establish whether a production workload needs different limits. Raising limits is not a substitute for investigating memory growth, event-loop stalls, database saturation, or retry amplification.

Mandate application and worker logs are structured JSON. Infrastructure log collectors must not add request authorization headers, secret files, database URLs, private receipt keys, raw replay idempotency keys, or handler payloads to logs. Local log rotation is a disk-safety boundary; durable log retention and SIEM shipping remain deployment responsibilities.

## 4. Network exposure

The reference topology intentionally minimizes exposed operational HTTP surfaces:

- API port `8787` is host-published to `127.0.0.1` by default.
- Expiry port `8788` and outbox port `8789` are only `expose`d to the private Compose network; they are not host-published.
- Worker `/metrics` and health routes are unauthenticated operational endpoints and must remain behind deployment network controls.
- A public deployment must place the API behind a TLS-terminating reverse proxy or load balancer with explicit request-size, connection, timeout, and trusted-proxy rules.
- Worker metrics may be scraped only from a trusted monitoring network or sidecar/agent boundary.

Changing a worker health bind to a routable interface does not make the endpoint safe for public exposure.

## 5. Health interpretation

### API

- `/health/live`: Node.js can serve the probe. It does not claim PostgreSQL is usable.
- `/health/ready`: PostgreSQL answered within the bounded readiness timeout and required migrations are present.
- Supervisors/load balancers route only while readiness succeeds.

### Expiry worker

- `/health/live`: process and health listener are alive.
- `/health/ready`: at least one recent successful cycle exists, failure threshold has not been crossed, and shutdown has not started.
- `/metrics`: cached process/backlog metrics; no database query is performed per scrape.

### Outbox worker

The same liveness/readiness distinction applies. A dead-letter is an operator signal but does not make the worker process itself unready; the worker may continue delivering unrelated events safely.

## 6. Reference alert baseline

The thresholds below are conservative **initial operational defaults**. They are intentionally derived from existing health/metrics semantics, not from an unmeasured throughput promise. Deployments may tighten them after load testing, but must not silently remove the corresponding failure signal.

### Availability and process health

| Signal | Initial condition | Severity | Required response |
|---|---|---|---|
| API `/health/ready` | non-200 continuously for 2 minutes | page | stop new routing if not already removed; inspect PostgreSQL, migration readiness, resource pressure and recent deploy |
| expiry `mandate_action_attempt_expiry_ready` | `0` continuously for 2 minutes after startup | page | inspect consecutive failures, last success and database connectivity |
| outbox `mandate_outbox_ready` | `0` continuously for 2 minutes after startup | page | inspect cycle failures, last success, handler health and database connectivity |
| any long-running process | repeated supervisor restarts within 10 minutes | page | halt rollout and inspect exit reason/resource exhaustion; do not create a restart loop |

A deployment must suppress expected startup/shutdown transitions so `STARTING` and `SHUTTING_DOWN` do not page during controlled operations.

### Action-attempt expiry

Use the exact exported metrics:

```text
mandate_action_attempt_expiry_failures_total
mandate_action_attempt_expiry_limit_reached_total
mandate_action_attempt_expiry_consecutive_failures
mandate_action_attempt_expiry_backlog_due
mandate_action_attempt_expiry_oldest_overdue_seconds
mandate_action_attempt_expiry_last_success_unixtime_seconds
mandate_action_attempt_expiry_ready
```

Reference conditions:

- page when `mandate_action_attempt_expiry_consecutive_failures` reaches the worker's configured readiness-failure threshold;
- warn when `mandate_action_attempt_expiry_oldest_overdue_seconds > 60` for 2 consecutive minutes;
- page when `mandate_action_attempt_expiry_oldest_overdue_seconds > 300` for 2 consecutive minutes;
- warn when `mandate_action_attempt_expiry_limit_reached_total` continues increasing for 5 minutes while `mandate_action_attempt_expiry_backlog_due > 0`;
- page when the last successful cycle age exceeds the configured readiness stale window and does not recover within 2 minutes.

The 60/300-second overdue thresholds are starting operational objectives, not changes to authorization semantics. Even before the materializer writes `EXPIRED`, an already-expired reservation cannot become valid merely because the worker is behind.

### Outbox

Use the exact exported metrics:

```text
mandate_outbox_failures_total
mandate_outbox_limit_reached_total
mandate_outbox_consecutive_failures
mandate_outbox_due_sample
mandate_outbox_stale_sample
mandate_outbox_dead_letter_sample
mandate_outbox_has_due
mandate_outbox_has_stale
mandate_outbox_has_dead_letter
mandate_outbox_last_success_unixtime_seconds
mandate_outbox_ready
```

Reference conditions:

- page on every increase of `mandate_outbox_dead_lettered_total`; a new dead letter always requires human investigation;
- keep an operator alert active while `mandate_outbox_has_dead_letter == 1`;
- warn when `mandate_outbox_has_stale == 1` persists for 2 minutes; page if it persists for 5 minutes;
- warn when `mandate_outbox_has_due == 1` persists for 5 minutes while readiness remains healthy;
- warn when `mandate_outbox_limit_reached_total` continues increasing for 5 minutes while due work remains;
- page when consecutive failures reach the configured readiness threshold or last-success freshness remains stale for 2 additional minutes.

`mandate_outbox_due_sample`, `mandate_outbox_stale_sample`, and `mandate_outbox_dead_letter_sample` are **capped samples, not exact global queue counts**. Alert logic must use them only as bounded evidence that work exists, never as billing, capacity, or loss accounting.

## 7. Initial operational objectives

Until production load data exists, use these as engineering objectives rather than customer-facing SLOs:

- healthy outbox due work should normally clear within 5 minutes;
- a new dead letter must be acknowledged by an operator during the active operational window and must never be auto-replayed;
- overdue action-attempt materialization should normally remain below 60 seconds and should be treated as urgent beyond 5 minutes;
- a recovery drill must prove artifact integrity and application-level continuity on a production-equivalent PostgreSQL major version before consequential use;
- a production deployment must define its own RPO/RTO, backup cadence, retention and point-in-time-recovery policy before launch.

No repository document should translate these initial objectives into contractual uptime, recovery, or delivery guarantees without measured evidence and an explicit product decision.

## 8. Dead-letter escalation and replay

A dead letter is immutable failure evidence. The worker never automatically resets or replays it.

For a live environment:

1. inspect the bounded safe projection;
2. identify and remediate the downstream or handler cause;
3. confirm the original event is still safe and necessary to deliver;
4. obtain the deployment's required human approval/change or incident reference;
5. record operator identity and a precise replay reason;
6. replay with the expected attempt count and a fresh high-entropy replay idempotency key;
7. observe the replacement until terminal delivery or a new dead letter.

The repository intentionally does **not** invent the organization's live approval policy. Until that policy is defined and enforced operationally, live dead-letter replay should be treated as prohibited.

## 9. Database incident and recovery escalation

If PostgreSQL is unavailable:

- API readiness fails closed and should stop new routing;
- workers may remain alive but become unready after their bounded failure/freshness thresholds;
- do not run migrations merely to make readiness green;
- do not change runtime services to use the migration owner;
- preserve logs and the last successful backup metadata;
- restore only into an explicitly disposable `mandate_restore_*` target during a drill.

`docs/DATABASE_RECOVERY.md` is the executable recovery procedure. The repository proves snapshot-consistent dump/restore, migration continuity, idempotent API replay, historical receipt verification, and outbox/dead-letter continuity. A production provider must still supply durable storage, backup scheduling, point-in-time recovery where required, geographic policy, and measured RPO/RTO.

## 10. Rollout and rollback

Promote one immutable image digest between environments. Before routing traffic:

1. run migrations with the migration identity;
2. run database-role configuration and require success;
3. start API/workers under their restricted identities;
4. require readiness;
5. verify metrics collection and paging paths;
6. inspect initial outbox/expiry backlog.

Application rollback is permitted only when the previous image is compatible with the already-applied schema. Database migrations are not automatically reversed by a container/image rollback. Never use an older image as an implicit schema downgrade.

If a migration or role-policy operation fails, stop the rollout. In particular, database-role configuration may deliberately leave runtime identities quiesced after a partial policy failure; correct the cause and rerun the role policy rather than bypassing it.

## 11. Incident evidence

For production incidents retain, outside the repository:

- immutable image digest and deployment/change identifier;
- affected environment and service identity;
- first/last observed timestamps;
- readiness reason and relevant low-cardinality metrics;
- safe structured log event IDs/error codes;
- dead-letter IDs and replay-record IDs where applicable, never payload dumps in ordinary incident chat;
- backup artifact digest and restore-drill result for recovery incidents;
- operator identity and approval/change reference for any replay or maintenance action;
- rollback/forward-fix decision and final verification.

## 12. Provider-specific work that remains outside this contract

Before consequential production use, a deployment still has to supply and verify:

- TLS termination, firewall/security-group rules and trusted-proxy configuration;
- an alerting/paging backend wired to this baseline;
- durable centralized logs and retention/SIEM policy;
- production backup scheduling, encrypted durable storage, PITR where required, and measured RPO/RTO;
- HA/failover topology if the product requires it;
- external review and operational ownership for real outbox delivery handlers;
- a live dead-letter replay approval policy;
- image vulnerability scanning, SBOM/provenance and release promotion controls.

Those are deployment decisions. The Mandate core remains provider-neutral.