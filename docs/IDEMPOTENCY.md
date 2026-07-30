# Idempotency and HTTP replay

## Contract

For a supported state-changing operation, an idempotency key is scoped by:

```text
(tenant, environment, operation scope, idempotency key)
```

The request fingerprint binds the HTTP method, normalized path, and canonical JSON body. Reusing a key with a different fingerprint returns `409 IDEMPOTENCY_CONFLICT`.

An exact retry returns:

- the original HTTP success status;
- the original logical response body;
- byte-identical canonical JSON;
- the same stable application headers;
- no duplicate domain state, audit event, or outbox message.

## Canonical response bytes

All JSON responses use deterministic canonical serialization. Object keys are sorted recursively, while array order remains significant. This prevents PostgreSQL `jsonb` key ordering from changing response bytes after a restart.

`Content-Length` is recomputed from the canonical bytes and therefore remains identical for an exact replay.

## Persisted HTTP metadata

Migration `003_idempotency_http_metadata` maintains the dedicated `response_status` and `response_headers` columns for every currently supported mutation scope.

Creation operations persist status `201`:

- `create-mandate`
- `create-approval`
- `issue-receipt`

Committed state transitions persist status `200`:

- `authorize`
- `revoke-mandate:{id}`
- `decide-approval:{id}`

The stable persisted headers are:

```http
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

An unknown idempotency scope is rejected by PostgreSQL instead of being silently assigned a guessed status.

## Headers that are not replayed

Some headers belong to the current transport attempt rather than the original domain response:

- `X-Request-Id` identifies the current retry and is regenerated or accepted from the current request;
- `Date`, connection management, and other Node.js transport headers are produced by the current server process;
- `Content-Length` is recomputed from the canonical response bytes.

The original request ID remains available in immutable audit and decision data where relevant. It is not reused as the retry's diagnostic correlation ID.

## Error behavior

Authentication, authorization, malformed requests, and domain errors are evaluated on each attempt and are not committed as successful idempotency records. Only a mutation that commits its domain state and idempotency row becomes replayable.

This avoids persisting transient precondition failures while preserving exactly one committed successful result.

## Concurrency

The idempotency row is inserted in the same transaction as domain state, audit event, and outbox message. Concurrent first attempts are serialized by the database uniqueness boundary and transaction retry policy.

## Retention policy

A committed idempotency record receives an `expires_at` timestamp seven days after creation. The service continues to replay an expired row until a maintenance run deletes it, so delayed cleanup extends replay protection rather than shortening it.

The cleanup policy has a hard seven-day minimum and may be configured up to 90 days:

```text
MANDATE_IDEMPOTENCY_RETENTION_SECONDS=604800
MANDATE_IDEMPOTENCY_CLEANUP_BATCH_LIMIT=500
MANDATE_IDEMPOTENCY_CLEANUP_MAX_BATCHES=20
```

A record is eligible for deletion only when PostgreSQL determines that both conditions are true:

1. `expires_at` has passed; and
2. `created_at` is at least the configured retention age.

This means a configuration error cannot delete a record before the original seven-day replay window.

## Cleanup operation

After migration `008_idempotency_retention` is applied by the deployment role, run the one-shot command from a scheduler or controlled maintenance job:

```bash
MANDATE_STORE=postgres \
MANDATE_ENVIRONMENT=live \
MANDATE_IDEMPOTENCY_RETENTION_SECONDS=604800 \
npm run idempotency:cleanup
```

The command:

- requires PostgreSQL and an explicit `test` or `live` environment;
- can optionally restrict cleanup to `MANDATE_TENANT_ID`;
- uses `clock_timestamp()` as the time authority;
- deletes bounded batches with `FOR UPDATE SKIP LOCKED`;
- is safe for overlapping scheduler runs;
- reports bounded expired/eligible samples and backlog timestamps only;
- never logs idempotency keys, fingerprints, response headers, or response bodies;
- does not use `MANDATE_API_KEY`;
- checks migration readiness but never applies migrations;
- deletes no mandate, decision, approval, attempt, receipt, audit, or outbox data.

After the batch budget is spent, two index-aligned samples—expired rows and deletion-eligible rows—are each capped at the configured batch limit. `limitReached` is derived from the bounded eligible sample rather than an unbounded full-table count. The next scheduled run can continue without weakening replay semantics.
