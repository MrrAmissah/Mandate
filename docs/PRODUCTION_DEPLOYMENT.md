# Production deployment foundation

This document defines the repository's production deployment contract. It is a hardened single-host reference, not a claim of high availability. Production operators must use a **dedicated PostgreSQL 16 Mandate database** with backups, point-in-time recovery, TLS verification, network controls and distinct credentials for each Mandate process. Do not apply the database-role policy to a database shared with another application.

## Trust boundaries

Mandate runs as four different process identities:

| Process | Authority |
|---|---|
| Migration/configuration job | Applies ordered schema migrations and explicit database grants, then exits. |
| API | Reads and mutates product state, but has no schema, cleanup, replay or worker authority. |
| Expiry worker | Expires reserved action attempts and writes the matching audit/outbox evidence. |
| Outbox worker | Claims and completes outbox work through an explicitly mounted trusted handler module. |

Idempotency cleanup and dead-letter inspection/replay use separate maintenance/operator credentials and should run as controlled one-shot jobs. They are deliberately not long-running services in the reference Compose file.

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

## Secret files

The entry point supports either the direct variable or its `_FILE` counterpart, never both:

- `DATABASE_URL` / `DATABASE_URL_FILE`
- `MANDATE_API_KEY` / `MANDATE_API_KEY_FILE`
- `MANDATE_PRIVATE_KEY_PEM` / `MANDATE_PRIVATE_KEY_PEM_FILE`
- `MANDATE_PUBLIC_KEY_PEM` / `MANDATE_PUBLIC_KEY_PEM_FILE`

Secret files must be readable regular files between 1 byte and 1 MiB. Values are never logged. The Compose reference mounts each secret read-only under `/run/secrets`.

## Database roles

Create the following login roles outside Mandate with unique high-entropy credentials and no superuser, database-creation, role-creation, replication or row-security-bypass attributes:

- `mandate_api`
- `mandate_expiry_worker`
- `mandate_outbox_worker`
- `mandate_maintenance`
- `mandate_operator`

Run migrations with a separate migration owner, then run:

```bash
DATABASE_URL_FILE=/run/secrets/migration_database_url \
npm run database:roles
```

The migration/configuration identity must own or be able to alter every application object in the dedicated database, revoke database/schema/object/default privileges and terminate sessions authenticated as a Mandate runtime role. Configuration is deliberately disruptive and must run before API and worker services start.

The policy fails closed unless migration 010 is present and every runtime role already exists with safe attributes. Runtime roles may neither inherit another role nor be inherited by another role. They may not own the database or any object in the dedicated database, including schemas, relations, routines, enums, domains or other user-defined types. Prepared transactions owned by a runtime identity also block configuration.

### Quiesced policy application

Role configuration is serialized by a PostgreSQL advisory lock and applies in two committed stages:

1. validate role attributes, migration state, role memberships, ownership and prepared transactions;
2. revoke runtime `CONNECT`, database `CREATE`/`TEMPORARY` and schema `CREATE`, then commit that quiescence boundary;
3. terminate every existing runtime-role session and repeat the prepared-transaction and ownership audits;
4. reset stale object and default privileges across every existing non-system schema;
5. grant only the exact Mandate schema/table privileges and restore runtime `CONNECT`.

This ordering closes the create-after-audit race: no runtime session can remain connected or reconnect between the final ownership audit and exact grants. If a later policy step fails, runtime roles intentionally remain quiesced rather than being restored with a partially applied policy. The failure log sets `rolesRemainQuiesced: true`; correct the database state and rerun the configuration job before starting services.

The policy removes known DDL and stale-access escape paths for runtime identities:

- `CREATE` and `TEMPORARY` are revoked at database level;
- `TEMPORARY` and `CONNECT` are revoked from `PUBLIC`;
- `CREATE` is revoked from `PUBLIC` and every runtime role across every existing non-system schema;
- schema, table, **column**, sequence and **all routine** privileges are reset for `PUBLIC` and runtime roles across every existing non-system schema—procedures are included;
- only `USAGE` on the `mandate` schema is restored to runtime roles;
- migration-owner defaults are scrubbed globally and in every inventoried schema for tables, sequences and routines, for `PUBLIC` and every runtime role.

A future migration therefore receives no runtime access through stale default grants. Re-run the policy after every migration and deliberately extend its exact grant map when a process genuinely needs a new object.

Role intent:

- API: product reads/writes and root/successor receipt issuance; no delete, cleanup or dead-letter replay.
- Expiry: action-attempt expiry plus audit/outbox inserts only.
- Outbox: outbox claims/completion and immutable attempt inserts only.
- Maintenance: idempotency inspection/deletion only.
- Operator: bounded dead-letter inspection/replay and its audit evidence only.

## Health contract

The API exposes separate unauthenticated operational probes:

| Route | Meaning |
|---|---|
| `/health` | Compatibility alias for liveness. |
| `/health/live` | The Node.js process can serve HTTP. It does not claim PostgreSQL is usable. |
| `/health/ready` | PostgreSQL answered within the configured timeout and migration 010 is present. Returns `503` while the process is shutting down. |

`MANDATE_API_READINESS_TIMEOUT_MS` defaults to 2,000 ms and is bounded between 100 and 10,000 ms. Readiness uses a dedicated one-connection pool whose **client acquisition** and SQL execution are both bounded by this value, so an exhausted application pool cannot accumulate unbounded probes. Database failures return only the stable reason `DATABASE_UNAVAILABLE`; SQL and driver messages are never returned. Supervisors and load balancers must use `/health/ready`, not `/health`, before routing traffic.

Expiry and outbox workers retain their own `/health/live`, `/health/ready` and `/metrics` listeners. Worker ports are not host-published by the reference topology.

## Compose start order

`deployment/compose.production.yaml` enforces:

1. migration job completes;
2. database-role policy completes;
3. API and workers start with their separate database secrets.

The API is loopback-published by default. Worker health ports are exposed only to the Compose network. Every long-running service has a readiness health check, dropped Linux capabilities, `no-new-privileges`, a read-only filesystem and bounded PIDs.

A trusted outbox handler file must be mounted explicitly. The image ships no wildcard or no-op production handler.

## Example

Set `MANDATE_IMAGE` to an immutable registry digest and provide the secret-file paths and required live identifiers, then run:

```bash
docker compose -f deployment/compose.production.yaml config
docker compose -f deployment/compose.production.yaml up -d
```

Do not expose the API directly to the public internet from this reference file. Put it behind a TLS-terminating reverse proxy or load balancer with request-size limits, connection limits, access logs that omit credentials, and explicit trusted-proxy handling.

## Mandatory follow-on gates

Before consequential autonomous use, production readiness still requires:

- tested backup, point-in-time recovery and restore verification;
- deployment-specific network policy and firewall rules;
- alert thresholds for API/worker readiness, stale leases, due backlog and dead letters;
- supervisor restart and rollback policy;
- an approval policy for live dead-letter replay;
- an externally reviewed trusted outbox handler;
- release provenance and vulnerability scanning for the container image.