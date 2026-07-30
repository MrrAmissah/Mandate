# Delivery roadmap

The roadmap is ordered by trust dependency. A later phase must not be treated as complete while an earlier security boundary remains simulated.

## Phase 0 — domain kernel

Status: merged.

Delivered mandate creation/revocation, explicit deny precedence, approval-gated actions, deterministic authorization outcomes, signed receipts, and the first HTTP API.

## Phase 1 — contract and invariant hardening

Status: merged.

Delivered payload-bound idempotency, single-use approval consumption, canonical JSON, request correlation, the expanded API contract, and the durable product/architecture/security blueprints.

## Phase 2 — durable multi-tenant core

Status: core runtime merged; operational hardening continues.

### Phase 2A — persistence contract

Status: merged.

Delivered tenant and test/live ownership, scoped credential primitives, atomic reference transactions, one-winner authorization tests, audit/outbox writes, pagination, and the durable PostgreSQL schema.

### Phase 2B — PostgreSQL runtime

Status: merged.

Delivered connection-pool composition, one client per transaction, stored-credential authentication, serializable bounded retries, explicit JSONB encoding, restart-safe persistence, and real isolation/concurrency tests.

### Phase 2C — transactional outbox execution

Status: merged.

Delivered ordered migrations, append-only attempt evidence, `SKIP LOCKED` claims, committed leases, stale recovery, late-worker rejection, retry/backoff, dead-letter transitions, and multi-worker tests.

### Phase 2D — exact idempotency replay

Status: merged.

Delivered canonical response bytes, persisted status and application headers, retry-specific request IDs, unknown-scope rejection, and restart-safe replay tests.

### Phase 2E — persistent signing keys

Status: merged.

Delivered tenant/environment-scoped Ed25519 public keys, active/retired/revoked states, atomic rotation, key-ID reuse protection, retry-safe startup registration, discovery, historical verification, and unsupported-key rejection.

### Phase 2F — idempotency retention operations

Status: implemented.

Delivered:

- a hard seven-day replay floor with configurable retention up to 90 days;
- one-shot scheduler-friendly cleanup with no API credential dependency;
- migration-readiness checks without migration authority;
- PostgreSQL `clock_timestamp()` as the retention authority;
- test/live and optional tenant scoping;
- bounded `FOR UPDATE SKIP LOCKED` deletion batches;
- index-aligned candidate ordering for environment-wide cleanup;
- safe count-only structured output;
- exact backlog inspection after the batch budget is exhausted;
- configuration, migration, source-posture, and real PostgreSQL multi-worker tests.

Remaining operational hardening:

- deployment migration-role separation and production runbook;
- outbox worker-process composition, metrics, alerting, and operator dead-letter replay;
- backup/restore and recovery drills.

## Phase 3 — execution and receipt lifecycle

Status: core execution, expiry, offline verification, artifact, and receipt-supersession boundaries merged.

### Phase 3A — single-use decision reservation

Status: merged.

Delivered:

- `ActionAttempt` resource;
- one reservation per `ALLOW` decision;
- 30–900 second reservation windows;
- tenant-scoped create/list/read routes;
- dedicated action-attempt scopes;
- atomic audit, outbox, and idempotency writes;
- decision-row locking and a unique database final arbiter;
- memory and real-PostgreSQL concurrency proofs.

Exit gate met:

- one decision produces at most one action attempt;
- non-allowed, inactive, already-receipted, or already-reserved decisions fail closed;
- a reservation is never represented as execution success.

### Phase 3B — attempt completion and receipt binding

Status: merged.

Delivered:

- controlled `RESERVED → COMPLETED | CANCELLED` transitions;
- terminal input/output hashes and tool/provider/model metadata;
- immutable completion and termination timestamps/request IDs;
- terminal control restricted to the reserving credential;
- public receipt creation only from a `COMPLETED` attempt;
- receipt schema v1.1 with signed `actionAttemptId`;
- `executedAt` bound to attempt completion rather than signature time;
- one root receipt per attempt and decision;
- receipt recovery after later mandate revocation;
- stable OpenAPI v0.6.0 for the complete execution lifecycle;
- memory and real-PostgreSQL concurrent receipt tests;
- migration 006 with terminal-shape and ownership constraints.

Exit gate met:

- a public receipt cannot exist without a completed attempt;
- terminal attempt evidence cannot be overwritten;
- signing retries do not duplicate execution or root receipts;
- cancelled or expired attempts cannot produce receipts.

### Phase 3B.1 — database-time reservation expiry

Status: merged.

Delivered:

- `ActionAttemptExpiryWorker` library boundary;
- PostgreSQL `clock_timestamp()` as the live expiry authority;
- due-row claims with `FOR UPDATE SKIP LOCKED`;
- atomic `RESERVED → EXPIRED` transition;
- system-actor audit events and transactional outbox messages;
- optional tenant partitioning within a test/live environment;
- bounded single-poll and drain APIs;
- deterministic memory tests;
- real PostgreSQL multi-worker one-winner proof;
- future and already-terminal attempts remain untouched.

### Phase 3B.2 — expiry process composition

Status: merged.

Delivered:

- dedicated `npm run worker:attempt-expiry` executable;
- no dependency on API credentials or API-process startup;
- explicit database and test/live environment posture;
- explicit live worker identity;
- migration-006 readiness check without migration authority;
- signal-aware shutdown and PostgreSQL-pool closure;
- bounded poll interval and cycle batch size;
- structured success/failure logs with safe error codes;
- in-process cycle, expiry, and failure counters;
- recovery after a failed cycle;
- configuration, entry-point, process, and PostgreSQL readiness tests.

### Phase 3B.3 — expiry observability and supervision

Status: merged.

Delivered:

- database-time scoped backlog inspection;
- reserved count, due count, oldest due timestamp, and oldest overdue age;
- cached backlog snapshots with no per-probe database queries;
- loopback-default `/health/live` and `/health/ready` endpoints;
- stable readiness reasons for starting, failures, staleness, and shutdown;
- Prometheus-compatible low-cardinality metrics;
- health listener startup after migration readiness and shutdown before pool closure;
- malformed-target protection and completion-time freshness;
- memory, HTTP, entry-point, and real-PostgreSQL backlog tests.

Remaining deployment work:

- platform-specific service manifest;
- restricted runtime database role;
- deployment network policy for non-loopback health binding;
- alert thresholds and overdue-backlog runbook;
- supervisor restart policy.

### Phase 3C.1 — offline verification and conformance

Status: merged.

Delivered:

- zero-dependency Node.js ESM verifier package with TypeScript declarations;
- exact active/retired Ed25519 verification semantics;
- stable failure reasons for malformed receipts, unknown/revoked keys, invalid key material, and tampering;
- one canonical JSON implementation shared by server issuance and offline verification;
- public-only signed receipt fixture with no private key;
- tamper corpus covering action, output, attempt identity, issue time, and signature mutation;
- parity tests against an independent server-style crypto verifier;
- dry-run package-content and package-syntax gates.

### Phase 3C.2 — strict key-set caching

Status: merged.

Delivered:

- permanently scope-bound cache instances;
- caller-injected discovery loader with no embedded HTTP;
- five-minute default lifetime with bounded override;
- freshness measured after loading completes;
- single-flight ordinary and unknown-key refreshes;
- strict expiry with no stale-key fallback;
- one unknown-key refresh per cached generation, bounded across random key IDs;
- failed-refresh suppression until the cache advances or is invalidated;
- invalid-receipt and unsupported-algorithm preflight without loader traffic;
- invalidation that detaches a pending loader while rejecting stale completion;
- retention of public discovery fields only;
- frozen cloned key material;
- safe `KEY_SET_UNAVAILABLE` results and error type;
- TypeScript declarations, package artifact coverage, and deterministic concurrency/failure tests.

Remaining integration work:

- SDK-level endpoint loader example;
- higher-level SDK cache composition and application guidance.

### Phase 3C.3 — reproducible verifier artifacts

Status: merged.

Delivered:

- deterministic `npm pack` artifact command;
- two isolated pack runs with matching SHA-256 and npm integrity requirements;
- exact package identity and public-file inventory checks;
- PEM private-key rejection;
- safe recursive output-path validation;
- stable manifest and `SHA256SUMS` output;
- read-only GitHub Actions artifact creation without a registry token;
- package reproducibility, manifest, checksum, and safety tests.

Remaining publication work:

- npm namespace and ownership decision;
- provenance attestation and release signing;
- registry publication workflow and approval boundary;
- published-version compatibility policy.

### Phase 3C.4 — append-only receipt supersession

Status: merged.

Delivered:

- receipt schema v1.2 with signed `supersedesReceiptId` and `supersessionReason`;
- immutable execution evidence copied from the predecessor rather than caller input;
- one immutable root per decision and action attempt;
- one direct successor per predecessor, producing a linear non-forking chain;
- predecessor verification through the tenant/environment signing-key registry;
- active and retired predecessor keys accepted; revoked, unknown, or tampered predecessors rejected;
- PostgreSQL key-row locking preventing revocation races during supersession;
- composite foreign-key enforcement preserving decision and action-attempt identity;
- payload-bound idempotent `POST /v1/receipts/{id}/supersede`;
- atomic successor, audit, outbox, and replay persistence;
- `receipt.superseded` audit/outbox events;
- OpenAPI v0.7.0;
- domain, HTTP, offline-verifier, and real-PostgreSQL concurrency tests;
- migration 007 and dedicated lifecycle documentation.

Exit gate met:

- corrections never rewrite signed history;
- concurrent corrections produce one direct successor;
- historical verification survives signing-key rotation;
- a revoked or unverifiable predecessor is never silently re-signed;
- offline and server verification agree on v1.2 signature integrity.

### Phase 3C.5 — compact receipt representation

Scope:

- optional compact/JWS representation after compatibility review;
- explicit mapping between compact and JSON receipt forms;
- versioning and downgrade policy.

This phase must not weaken canonical JSON verification or the append-only correction model.

## Phase 4 — approval operations

Scope:

- approver policies and groups;
- approval inbox and assignment endpoints;
- cancellation and expiry worker;
- Slack, email, and mobile-link delivery adapters;
- approval comments and evidence links;
- optional multi-party thresholds;
- durable workflow-resumption callbacks.

Exit gate:

- approval notifications are retried through the outbox;
- decision and consumption are fully auditable;
- expired or cancelled approvals cannot authorize an action.

## Phase 5 — webhooks and integrations

Scope:

- webhook endpoint management;
- timestamped HMAC signatures;
- retries, delivery logs, dead letters, and replay;
- GitHub reference adapter;
- MCP middleware;
- A2A integration profile;
- Vercel and Gmail reference policies.

Exit gate:

- at least one real protected workflow runs end to end;
- integrations translate to canonical resources and actions;
- connector-specific behavior never bypasses core evaluation.

## Phase 6 — developer experience

Scope:

- TypeScript SDK;
- CLI;
- generated API reference site;
- quickstarts and runnable examples;
- policy simulator;
- local development mode;
- test clocks and fixture keys;
- import/export for mandate templates.

Exit gate:

- a new developer can protect a tool call from documentation alone;
- SDK behavior matches raw HTTP semantics;
- examples run in CI.

## Phase 7 — tool-call firewall and enterprise controls

Scope:

- user-intent and tool-argument comparison;
- data-egress policies;
- untrusted-content provenance markers;
- policy bundles and organization defaults;
- SSO/OIDC and role-based administration;
- audit export, SIEM sinks, retention controls;
- regional data placement;
- usage metering and billing hooks.

This phase extends Mandate-API beyond delegated authorization without weakening the deterministic core.
