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

## Concurrency and retention

The idempotency row is inserted in the same transaction as domain state, audit event, and outbox message. Concurrent first attempts are serialized by the database uniqueness boundary and transaction retry policy.

Records currently expire after seven days. Retention cleanup and configurable policy remain operational follow-up work.
