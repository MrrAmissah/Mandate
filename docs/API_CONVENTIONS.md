# API conventions

This document defines the stable HTTP behavior Mandate-API currently preserves across the implemented v1 endpoints. Future controls are identified explicitly rather than described as current behavior.

## 1. Base URL and versioning

Local development uses:

```text
http://localhost:8787/v1
```

The major version is encoded in the path. Compatible additions may ship within v1. Breaking field removals, semantic changes, or state-machine changes require an explicit contract review and version change.

The current OpenAPI contract revision is v0.9.0. That document revision is not the same thing as the `/v1` HTTP major version.

## 2. Content type

Requests and responses use UTF-8 JSON:

```http
Content-Type: application/json
Accept: application/json
```

Security-sensitive create, transition, assignment, and decision routes reject malformed JSON and validate their accepted fields. Unknown fields must never become hidden authority inputs.

## 3. Authentication and scopes

The current runtime authenticates API credentials with:

```http
X-Api-Key: <credential secret>
```

Credentials are tenant- and environment-scoped. Durable storage contains only the credential hash and safe metadata, never the plaintext secret.

A valid API credential is not automatically a human approver. Approval decision authority additionally requires:

1. the dedicated `approvals:decide` scope;
2. an active credential binding to a durable approver identity;
3. an active approval assignment; and
4. membership in that assignment's immutable eligibility snapshot.

Approval administration and approver work visibility are deliberately separate:

```text
approvers:read
approvers:write
approvals:read
approvals:write
approvals:decide
approval_inbox:read
```

`approvals:read` is an administrative tenant-visible collection permission. It does not grant access to the approver inbox. `approval_inbox:read` permits the caller to request an inbox view, but each returned item still requires the authenticated credential to resolve to an active approver identity that is eligible under the current active assignment.

Future OAuth/OIDC or SSO may replace or supplement the authentication mechanism, but it should bind into the durable approver identity model instead of redefining credentials as people.

## 4. Request IDs

Clients may provide:

```http
X-Request-Id: req_client_generated_value
```

The server validates or replaces it and returns the effective value in the `X-Request-Id` response header and error body. Request IDs are diagnostic correlation values, not idempotency controls.

## 5. Idempotency

State-changing mutation endpoints support:

```http
Idempotency-Key: unique-client-generated-key
```

Rules:

- key maximum: 255 characters in the current contract;
- scope: tenant, environment, and exact logical operation;
- retention floor: seven days for durable replay records;
- the stored request fingerprint includes method, normalized path, and canonical JSON body at the HTTP boundary;
- replay with the same fingerprint returns the committed logical response;
- reuse with a different fingerprint returns `409 IDEMPOTENCY_CONFLICT`;
- concurrent first use is resolved atomically;
- unknown operation scopes are rejected rather than receiving guessed response metadata.

Read-only inbox routes do not create idempotency records.

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
| 401 | Missing, invalid, expired, or revoked credential |
| 403 | Authenticated credential lacks required scope or authority |
| 404 | Tenant-scoped or current-authority-visible resource does not exist |
| 409 | State, idempotency, assignment, or concurrency conflict |
| 413 | Request exceeds configured size limit |
| 500 | Unexpected server error |
| 503 | Required dependency or signing authority unavailable |

Cross-tenant access returns tenant-safe not-found behavior rather than confirming object existence. Inbox item lookup also returns `404` when a pending approval exists administratively but is not visible through the authenticated approver's current assignment authority.

## 7. Resource identifiers

IDs are opaque strings with readable prefixes. Implemented resources include:

```text
ten_   tenant
key_   API credential
mnd_   mandate
apr_   approval
apv_   approver identity
apb_   approver credential binding
apg_   approver group
agm_   approver group membership
apa_   approval assignment
dec_   authorization decision
att_   action attempt
rcpt_  receipt
aud_   audit event
out_   outbox message
```

Clients must not parse business semantics from the suffix.

## 8. Timestamps

API timestamps are RFC 3339 UTC strings:

```text
2026-07-29T06:45:12.123Z
```

Time-window comparisons are half-open where documented, such as `validFrom <= now < validUntil`.

PostgreSQL time is authoritative for live action-attempt expiry, approval-inbox actionable/overdue classification in PostgreSQL mode, and operational backlog age. Application clocks are used only where the relevant domain contract explicitly permits them.

## 9. Pagination

Implemented collection endpoints use bounded cursor-style pagination with `limit` from 1 through 100, defaulting to 20.

General tenant collections preserve the existing opaque cursor behavior. The approval inbox uses a keyset cursor over the visible item's `(requestedAt, id)` ordering and performs the `limit + 1` window inside PostgreSQL so unrelated approval traffic is not materialized in application memory.

Responses use the current flat page shape:

```json
{
  "data": [],
  "hasMore": true,
  "nextCursor": "opaque-cursor"
}
```

The inbox additionally returns the resolved state filter:

```json
{
  "data": [],
  "hasMore": false,
  "nextCursor": null,
  "state": "ACTIONABLE"
}
```

A cursor is valid only within the visibility/order semantics of the collection that issued it. Clients must not transplant cursors between endpoints or security contexts.

## 10. Filtering and ordering

Only filters explicitly implemented and documented by an endpoint may be relied upon. Clients must not infer generic filtering behavior from another collection.

Administrative approval listing and the authenticated approver inbox are separate concerns:

- `GET /v1/approvals` lists tenant-visible approval records under `approvals:read`;
- `GET /v1/approval-inbox` derives the current approver from the authenticated credential and requires `approval_inbox:read`;
- the inbox orders visible items by `requestedAt`, then approval ID;
- `state=ACTIONABLE` is the default and includes only durable `PENDING` approvals whose expiry is still in the future (or absent);
- `state=PENDING` includes all currently visible durable `PENDING` approvals, including overdue requests whose expiry transition has not yet been materialized;
- overdue items are returned with `actionable=false` and `overdue=true` and must never be treated as decision authority merely because they remain inspectable.

Reassignment changes the current assignment and therefore removes the item from the previous assignee's inbox. Terminal approval states are not inbox items.

## 11. Concurrency and mutable resources

Security-critical transitions use database locking, serializable transactions, uniqueness constraints, immutable history, or compare-and-swap semantics as appropriate.

Implemented examples include:

- final mandate-use one-winner behavior;
- single-use approval consumption;
- one active approval assignment per approval;
- one terminal approval decision under concurrent eligible approvers;
- one action-attempt reservation per allowed decision;
- one root receipt per completed attempt/decision;
- one direct receipt successor per predecessor;
- one dead-letter replay replacement per source.

The approval inbox is a derived read model, not a source of authority. Decision/reassignment/cancellation transactions remain the security-critical write boundary even if an inbox response becomes stale immediately after it is read.

The API does not currently expose a universal ETag/`If-Match` convention. If added later, it must supplement—not replace—database enforcement for security-critical transitions.

## 12. Approval assignment and inbox semantics

Approval creation includes an assignment selector, but persisted approval resources and assignment resources are distinct.

Direct assignment snapshots one approver. Group assignment snapshots the group's active members at assignment time. Later membership additions affect future assignment snapshots only.

Reassignment ends the current assignment and creates a new one with a new eligibility snapshot. It never edits old eligibility rows.

`POST /v1/approvals/{id}/decide` accepts the decision and optional reason. It does not accept authoritative `decidedBy` input. The server derives the approver identity from authentication and persists that identity as decision evidence.

`GET /v1/approval-inbox` and `GET /v1/approval-inbox/{id}` are projections over current authority, not durable assignment history. Visibility requires all of the following at read time:

1. the authenticated credential has `approval_inbox:read`;
2. the credential has an active binding to an active approver identity;
3. the approval is durably `PENDING`;
4. the approval has a current `ACTIVE` assignment; and
5. the approver identity is present in that assignment's immutable eligibility snapshot.

The inbox may become stale between read and decision. The decision endpoint therefore re-evaluates authority and the database independently enforces the terminal transition; an inbox row is never an authorization token.

## 13. Expandable relationships

Unbounded relationship expansion is not part of the current contract. Relationships are exposed through explicit resource IDs and dedicated routes such as the approval assignment route. Inbox items intentionally expose only the bounded assignment and approver fields needed to understand current work.

If expansion is introduced later, it must be allowlisted and bounded.

## 14. Rate limits

A public rate-limit header contract is not implemented yet. Deployment-edge throttling may be used as an external control, but clients must not currently depend on `RateLimit-*` headers from the core API.

Future application-level rate limiting must distinguish authorization/decision traffic from ordinary reads and must not create an authority bypass during overload.

## 15. Webhooks

Public webhook endpoint management and delivery signatures are future Phase 5 work. The current durable outbox, supervised worker, immutable delivery-attempt evidence, dead-letter state, and controlled replay machinery provide the internal delivery foundation only.

A future webhook contract is expected to use timestamped signatures, unique delivery IDs, bounded retry, and replay-safe delivery history, but none of those public endpoint semantics should be treated as shipped until they appear in OpenAPI.

## 16. Deprecation and security tightening

Deprecated fields and endpoints should include migration guidance and an announced sunset where practical. Security fixes may tighten validation without the normal deprecation window when preserving previous behavior would retain an authority bypass.

Migration 011 is such a boundary for approval decisions: pre-existing free-text `decided_by` history remains readable for compatibility, but new terminal decisions require authenticated durable approver evidence and cannot use caller-supplied text as authority.

Migration 013 is an operational contract boundary for the inbox read path: API readiness fails closed until the authority-first eligibility and pending-order indexes are registered, preventing the production API from serving the v0.9 inbox surface on an older schema posture.
