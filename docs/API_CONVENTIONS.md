# API conventions

This document defines the stable HTTP behavior Mandate-API should preserve across all v1 endpoints.

## 1. Base URL and versioning

```text
https://api.mandate.example/v1
```

The major version is encoded in the path. Compatible additions may ship within v1. Breaking field removals, semantic changes, or state-machine changes require a new major version.

## 2. Content type

Requests and responses use UTF-8 JSON:

```http
Content-Type: application/json
Accept: application/json
```

Unknown request fields should be rejected on security-sensitive create and decision endpoints once schemas are stable. Read responses may gain new fields without a major version change.

## 3. Authentication

Initial developer preview:

```http
Authorization: Bearer mnd_test_...
```

The Milestone 0 `x-api-key` header remains temporary and will be removed before public v1.

Credentials are tenant- and environment-scoped. The plaintext secret is returned only at creation time. Stored credentials are hashed and have explicit scopes.

## 4. Request IDs

Clients may provide:

```http
X-Request-Id: req_client_generated_value
```

The server validates or replaces it and always returns the effective value in both the `X-Request-Id` response header and error body. Request IDs are diagnostic correlation values, not idempotency controls.

## 5. Idempotency

All state-changing `POST` endpoints accept and eventually require:

```http
Idempotency-Key: unique-client-generated-key
```

Rules:

- key length: 16 to 255 printable ASCII characters;
- scope: tenant, environment, method, and route operation;
- retention: at least 24 hours, with a target of 7 days;
- the stored request fingerprint includes method, normalized path, API version, authenticated tenant, and canonical JSON body;
- replay with the same fingerprint returns the original status and response;
- reuse with a different fingerprint returns `409 IDEMPOTENCY_CONFLICT`;
- concurrent first use must be resolved atomically.

## 6. Errors

Errors use one envelope:

```json
{
  "error": {
    "code": "RESOURCE_OUT_OF_SCOPE",
    "message": "The resource is outside the delegated scope.",
    "details": {
      "field": "resource"
    },
    "requestId": "req_..."
  }
}
```

`code` is stable and machine-readable. `message` is developer-readable and may improve without versioning. `details` must never contain secrets.

Common status mapping:

| Status | Meaning |
|---|---|
| 400 | Invalid input or malformed JSON |
| 401 | Missing or invalid credential |
| 403 | Authenticated client lacks scope |
| 404 | Tenant-scoped resource does not exist |
| 409 | State conflict, replay conflict, or optimistic concurrency failure |
| 413 | Request exceeds size limit |
| 422 | Structurally valid request fails domain validation |
| 429 | Rate limit exceeded |
| 500 | Unexpected server error |
| 503 | Required dependency unavailable |

Cross-tenant access should normally return `404`, not reveal resource existence.

## 7. Resource identifiers

IDs are opaque strings with readable prefixes:

```text
ten_  tenant
key_  API credential
pri_  principal
agt_  agent
mnd_  mandate
apr_  approval
dec_  authorization decision
act_  action attempt
rcpt_ receipt
aud_  audit event
wh_   webhook endpoint
whd_ webhook delivery
sk_   signing key
```

Clients must not parse semantics from the suffix.

## 8. Timestamps

All timestamps are RFC 3339 UTC strings with millisecond precision:

```text
2026-07-29T06:45:12.123Z
```

Intervals are half-open unless documented otherwise: `validFrom <= now < validUntil`.

## 9. Pagination

Collection endpoints use cursor pagination:

```http
GET /v1/mandates?limit=50&after=mnd_...
```

```json
{
  "data": [],
  "page": {
    "hasMore": true,
    "nextCursor": "opaque_cursor"
  }
}
```

Default limit is 25; maximum is 100. Cursors are opaque, signed or authenticated, and scoped to the original filter set.

## 10. Filtering and ordering

Filters are explicit query parameters. The default sort is newest first unless endpoint semantics require event order.

Examples:

```text
status=ACTIVE
agentId=agt_...
createdAfter=2026-07-01T00:00:00Z
createdBefore=2026-08-01T00:00:00Z
```

Audit events default to ascending sequence order when replaying a lifecycle.

## 11. Optimistic concurrency

Mutable resources expose a numeric `revision` and an `ETag`. Mutating an existing resource should accept `If-Match` or an expected revision. Stale writes return `409 REVISION_CONFLICT`.

Security-critical transitions such as authorization counters and approval consumption additionally require database locking or compare-and-swap semantics.

## 12. Expandable relationships

Responses use IDs by default. Selected relationships may be expanded explicitly:

```http
GET /v1/receipts/rcpt_...?expand=mandate,approval
```

Unbounded expansion is forbidden.

## 13. Rate limits

Responses expose:

```http
RateLimit-Limit: 1000
RateLimit-Remaining: 998
RateLimit-Reset: 42
```

Limits are enforced by credential, tenant, environment, route class, and abuse signals. Authorization endpoints receive a separately managed high-priority budget.

## 14. Webhooks

Webhook events use a common envelope:

```json
{
  "id": "evt_...",
  "type": "approval.approved",
  "apiVersion": "2026-07-29",
  "createdAt": "2026-07-29T06:45:12.123Z",
  "tenantId": "ten_...",
  "environment": "test",
  "data": {
    "object": {}
  }
}
```

Deliveries include timestamped HMAC signatures, unique delivery IDs, bounded exponential backoff, manual replay, and an append-only attempt history.

## 15. Deprecation

Deprecated fields and endpoints include response headers linking to migration guidance and an announced sunset date. Security fixes may tighten validation without the normal deprecation window when unsafe behavior must be removed.
