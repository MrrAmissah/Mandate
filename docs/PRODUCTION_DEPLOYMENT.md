# Production deployment foundation

This document defines the repository's production deployment contract. It is a hardened single-host reference, not a claim of high availability. Production operators must use a **dedicated PostgreSQL 16 Mandate database** with durable backups, TLS verification, network controls and distinct credentials for each Mandate process. Do not apply the database-role policy to a database shared with another application.

The deployment-neutral supervision, alerting, incident and rollback rules are defined in [`PRODUCTION_OPERATIONS.md`](./PRODUCTION_OPERATIONS.md). Executable backup and restore procedures are defined in [`DATABASE_RECOVERY.md`](./DATABASE_RECOVERY.md).

## Trust boundaries

Mandate runs as five long-lived/service process identities plus privileged one-shot jobs:

| Process | Authority |
|---|---|
| Migration/configuration job | Applies ordered schema migrations and explicit database grants, then exits. |
| API | Reads and mutates product state, but has no schema, cleanup, replay or worker authority. |
| Action-attempt expiry worker | Expires reserved action attempts and writes matching audit/outbox evidence. |
| Approval-expiry worker | Materializes overdue `PENDING` or `APPROVED` approvals as `EXPIRED`, terminates active assignments and writes matching audit/outbox evidence. |
| Outbox worker | Claims and completes outbox work through an explicitly mounted trusted handler module. |

Idempotency cleanup and dead-letter inspection/replay use separate maintenance/operator credentials and should run as controlled one-shot jobs. Backup and restore commands also require infrastructure-controlled database authority and are not API/worker responsibilities. These jobs are deliberately not long-running services in the reference Compose file.

## Image contract

`Dockerfile` produces one non-root runtime image for every process. The final image:

- pins Node.js 22.23.1 Bookworm-slim by both tag and immutable SHA-256 digest in every stage;
- installs production dependencies with `npm ci --omit=dev --ignore-scripts`;
- runs as UID/GID `10001`;
- contains no test tree, Git history, environment file or local secret;
- uses a secret-aware entry point;
- supports a read-only root filesystem and a small no-exec `/tmp` tmpfs.

Container commands invoke Node directly rather than `npm run`, so a read-only runtime does not depend on npm cache or error-log writes. CI pins its PostgreSQL service by digest, builds the real image, verifies its configured user, runs the Node binary from the image and renders the complete Compose topology.

Deployments should promote the same image digest between environments. Do not rebuild separately for test and live.

## Reference resource and log bounds

The shared Compose service contract applies explicit starting bounds:

- `pids_limit: 256`;
- `MANDATE_SERVICE_CPUS` default `1.0` CPU;
- `MANDATE_SERVICE_MEMORY_LIMIT` default `512m`;
- a `64m` no-exec/nosuid/nodev `/tmp` tmpfs;
- Docker `json-file` logs with `MANDATE_LOG_MAX_SIZE` default `10m` and `MANDATE_LOG_MAX_FILES` default `5`;
- `SIGTERM` shutdown with a 30-second grace period.

Long-running API/worker services use `restart: unless-stopped`. Migration and database-role configuration jobs override this with `restart: "no"` so a failed privileged operation is never blindly retried by the supervisor.

These are safety budgets, not load-tested capacity guarantees. Tune them only with observed workload evidence and retain explicit limits in the deployment platform.

## Secret files

The entry point supports either the direct variable or its `_FILE` counterpart, never both:

- `DATABASE_URL` / `DATABASE_URL_FILE`
- `MANDATE_RECOVERY_TARGET_URL` / `MANDATE_RECOVERY_TARGET_URL_FILE`
- `MANDATE_API_KEY` / `MANDATE_API_KEY_FILE`
- `MANDATE_PRIVATE_KEY_PEM` / `MANDATE_PRIVATE_KEY_PEM_FILE`
- `MANDATE_PUBLIC_KEY_PEM` / `MANDATE_PUBLIC_KEY_PEM_FILE`

Secret files must be readable regular files between 1 byte and 1 MiB. Values are never logged. The Compose reference mounts service secrets read-only under `/run/secrets`. Recovery tooling may use the same entrypoint contract when run inside the production image.

## Database roles

Create the following login roles outside Mandate with unique high-entropy credentials and no superuser, database-creation, role-creation, replication or row-security-bypass attributes:

- `mandate_api`
- `mandate_expiry_worker`
- `mandate_approval_expiry_worker`
- `mandate_outbox_worker`
- `mandate_maintenance`
- `mandate_operator`

Run migrations with a separate migration owner, then run:

```bash
DATABASE_URL_FILE=/run/secrets/migration_database_url \
npm run database:roles
```

The migration/configuration identity must own or be able to alter every application object in the dedicated database, revoke database/schema/object/default privileges and terminate sessions authenticated as a Mandate runtime role. Configuration is deliberately disruptive and must run before API and worker services start.

The policy fails closed unless migration `014_approval_expiry` is present and every runtime role already exists with safe attributes. Runtime identities may not use PostgreSQL's reserved `pg_` predefined-role namespace. Runtime roles may neither inherit another role nor be inherited by another role. They may not own the database or any object in the dedicated database, including schemas, relations, routines, enums, domains or other user-defined types. Prepared transactions owned by a runtime identity also block configuration.

### Quiesced policy application

Role configuration is serialized by a PostgreSQL advisory lock and applies in committed stages:

1. validate role attributes, migration state, role memberships, ownership and prepared transactions;
2. revoke runtime `CONNECT`, database `CREATE`/`TEMPORARY` and schema `CREATE`, then commit that quiescence boundary;
3. terminate every existing runtime-role session and repeat the prepared-transaction and ownership audits;
4. reset stale object and default privileges across every existing non-system schema;
5. grant only the exact Mandate schema/table privileges and restore runtime `CONNECT`.

This ordering closes the create-after-audit race: no runtime session can remain connected or reconnect between the final ownership audit and exact grants. If a later policy step fails, runtime roles intentionally remain quiesced rather than being restored with a partially applied policy. Correct the database state and rerun the configuration job before starting services.

The policy removes known DDL and stale-access escape paths for runtime identities. Only `USAGE` on the `mandate` schema and exact table privileges are restored. A future migration therefore receives no runtime access through stale default grants. Re-run the policy after every migration and deliberately extend its exact grant map when a process genuinely needs a new object.

Role intent:

- API: product reads/writes and root/successor receipt issuance; no delete, cleanup or worker authority.
- Action-attempt expiry: `action_attempts` expiry plus audit/outbox inserts only.
- Approval expiry: approval/assignment expiry plus audit/outbox inserts only; no action-attempt mutation.
- Outbox: outbox claims/completion and immutable attempt inserts only.
- Maintenance: idempotency inspection/deletion only.
- Operator: bounded dead-letter inspection/replay and its audit evidence only.

Real PostgreSQL role tests prove the two expiry workers cannot mutate each other's domain tables.

## Health contract

The API exposes separate unauthenticated operational probes:

| Route | Meaning |
|---|---|
| `/health` | Compatibility alias for liveness. |
| `/health/live` | The Node.js process can serve HTTP. It does not claim PostgreSQL is usable. |
| `/health/ready` | PostgreSQL answered within the configured timeout and migration `014_approval_expiry` is present. Returns `503` while the process is shutting down. |

`MANDATE_API_READINESS_TIMEOUT_MS` defaults to 2,000 ms and is bounded between 100 and 10,000 ms. Readiness uses a dedicated one-connection pool whose client acquisition and SQL execution are both bounded by this value, so an exhausted application pool cannot accumulate unbounded probes. Database failures return only the stable reason `DATABASE_UNAVAILABLE`; SQL and driver messages are never returned. Supervisors and load balancers must use `/health/ready`, not `/health`, before routing traffic.

The action-attempt expiry, approval-expiry and outbox workers each expose their own `/health/live`, `/health/ready` and `/metrics` listeners. Worker ports are not host-published by the reference topology. The approval-expiry worker defaults to port `8790` and requires a recent successful cycle for readiness.

## Compose start and supervision order

`deployment/compose.production.yaml` enforces:

1. migration job completes;
2. database-role policy completes;
3. API, action-attempt expiry, approval-expiry and outbox workers start with separate database secrets.

The API is loopback-published by default. Worker health ports are exposed only to the Compose network. Every long-running service has a readiness health check, dropped Linux capabilities, `no-new-privileges`, a read-only filesystem, bounded PIDs, explicit CPU/memory budgets, bounded local log retention and a graceful shutdown signal/deadline.

A trusted outbox handler file must be mounted explicitly. The image ships no wildcard or no-op production handler.

## Approval-expiry service

The approval-expiry process starts only after migration 014 is present. In live environments `MANDATE_APPROVAL_EXPIRY_WORKER_ID` is mandatory. It never consumes `MANDATE_API_KEY` and never applies migrations.

Its PostgreSQL role can:

- read schema migration readiness;
- select/update approvals;
- select/update approval assignments;
- append audit sequence/event state;
- append transactional outbox messages.

It cannot mutate API credentials, approver identities/groups/eligibility, mandates, decisions, action attempts, receipts, outbox delivery attempts, idempotency state or replay records.

The worker uses PostgreSQL time and bounded `FOR UPDATE SKIP LOCKED` claims. It handles overdue `PENDING` and `APPROVED` approvals. A valid approval decision made before the deadline does not create unlimited authority: if it is not consumed before `expires_at`, PostgreSQL blocks consumption and the worker converges the approval to `EXPIRED`.

## Backup and restore proof

The repository contains executable snapshot-consistent `pg_dump`/`pg_restore` tooling and a real PostgreSQL recovery test. Current recovery proof requires migration `014_approval_expiry` and verifies critical durable-state counts, idempotent API replay, approval authority/deadline state, historical Ed25519 receipt verification, outbox/dead-letter continuity and exclusion of writes committed after the exported backup snapshot.

See [`DATABASE_RECOVERY.md`](./DATABASE_RECOVERY.md). This is repository-level recoverability proof, not a production RPO/RTO or provider backup policy. A production owner must still configure durable encrypted backup storage, cadence, retention, PITR where required and production-equivalent recovery exercises.

## Example

Set `MANDATE_IMAGE` to an immutable registry digest and provide the secret-file paths and required live identifiers, including `MANDATE_APPROVAL_EXPIRY_WORKER_ID` and the approval-expiry database secret, then run:

```bash
docker compose -f deployment/compose.production.yaml config
docker compose -f deployment/compose.production.yaml up -d
```

Do not expose the API directly to the public internet from this reference file. Put it behind a TLS-terminating reverse proxy or load balancer with request-size limits, connection limits, access logs that omit credentials, and explicit trusted-proxy handling.

## Mandatory deployment-specific gates

Before consequential autonomous use, the repository still cannot choose or prove the deployment provider's:

- TLS termination, firewall/security-group rules and trusted-proxy policy;
- paging/alert backend wired to the repository's supervision baseline;
- durable centralized log retention/SIEM pipeline;
- production backup schedule, encrypted storage, PITR policy and measured RPO/RTO;
- HA/failover topology where required;
- live dead-letter replay approval policy;
- external review and operational ownership of the real outbox delivery handler;
- container image vulnerability scanning, SBOM/provenance and release promotion controls.

These are explicit go-live gates, not reasons to couple Mandate core runtime to a particular cloud.
