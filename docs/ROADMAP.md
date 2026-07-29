# Delivery roadmap

The roadmap is ordered by trust dependency. A later phase must not be treated as complete while an earlier security boundary remains simulated.

## Phase 0 — domain kernel

Status: merged.

Delivered:

- mandate creation and revocation;
- explicit deny precedence;
- approval-gated actions;
- `ALLOW`, `DENY`, and `REQUIRE_APPROVAL` outcomes;
- signed receipts and verification;
- basic HTTP API and tests;
- documented in-memory and single-key limitations.

## Phase 1 — contract and invariant hardening

Status: merged.

Delivered:

- payload-bound idempotency;
- single-use approval consumption;
- canonical JSON hashing;
- request IDs and consistent error correlation;
- expanded OpenAPI contract;
- final product, architecture, API, and security blueprints;
- `Mandate-API` naming and documentation structure;
- dedicated project asset directory.

Exit gate:

- all current operations documented;
- hardening tests green;
- no claim of production durability;
- branch reviewed and merged through CI.

## Phase 2 — durable multi-tenant core

Status: in progress.

### Phase 2A — persistence contract

Status: merged.

Delivered:

- tenant and test/live ownership at the API and store boundary;
- scoped API authentication primitives;
- hash-only API credential records with rotation/revocation lifecycle;
- transactionally atomic reference store with rollback;
- one-winner concurrency tests for mandate uses and approvals;
- append-only audit-event and transactional-outbox writes;
- cursor-paginated collection endpoints;
- PostgreSQL schema and reversible development migration;
- immutable decision, receipt, and audit tables.

### Phase 2B — PostgreSQL runtime

Status: merged.

Delivered:

- exact `pg` dependency and connection-pool composition;
- one checked-out client per transaction;
- migration command and PostgreSQL CI service;
- tenant-scoped PostgreSQL repositories;
- stored-credential authentication with atomic last-used/revocation checking;
- serializable authorization transactions with bounded retry;
- explicit JSONB serialization;
- restart-safe state and idempotency tests;
- real cross-tenant, concurrency, denial-persistence, approval, receipt, and immutability tests;
- live-mode posture gates for storage, scopes, secrets, and signing keys.

### Phase 2C — transactional outbox execution

Status: merged.

Delivered:

- ordered migrations protected by one 64-bit PostgreSQL advisory lock;
- append-only outbox attempt evidence;
- exact-handler claims with `FOR UPDATE SKIP LOCKED`;
- environment-scoped and optionally tenant-scoped workers;
- committed leases before handler I/O;
- stale-lease recovery and old-worker rejection;
- bounded exponential retry and dead-letter transitions;
- safe error-code persistence without raw handler exceptions;
- multi-worker PostgreSQL concurrency and failure-path tests;
- no automatically registered handler or worker process.

### Phase 2D — exact idempotency replay

Status: in progress.

Delivered in the replay hardening branch:

- canonical JSON response bytes for deterministic serialization;
- exact successful status mapping for every supported mutation scope;
- stable persisted application headers;
- PostgreSQL rejection of unknown idempotency scopes;
- retry-specific `X-Request-Id` behavior;
- memory and restart-safe PostgreSQL byte-replay tests;
- migration 003 with backfill of existing metadata.

Remaining before Phase 2 closes:

- persistent signing-key lifecycle;
- deployment migration role separation and production runbook;
- worker process composition, metrics, alerting, and operator dead-letter replay;
- database-time and production clock-skew policy;
- idempotency retention cleanup and configurable policy.

Exit gate:

- restart-safe behavior;
- cross-tenant isolation tests;
- concurrency tests prove one-time consumption;
- exact committed HTTP replay is proven after restart;
- outbox leases and late-worker behavior are proven against PostgreSQL;
- migration and rollback procedures documented.

## Phase 3 — execution and receipt lifecycle

Scope:

- action attempts;
- decision reservation and replay controls;
- receipt issuance bound to attempt completion;
- persistent signing keys;
- key rotation and JWKS-style discovery;
- receipt correction/supersession model;
- offline verifier package.

Exit gate:

- decisions cannot be silently reused;
- receipt verification survives key rotation;
- signing failures are recoverable without duplicate receipts.

## Phase 4 — approval operations

Scope:

- approver policies and groups;
- approval inbox/list endpoints;
- cancellation and expiry worker;
- Slack, email, and mobile-link delivery adapters;
- approval comments and evidence links;
- optional multi-party thresholds;
- durable workflow resumption callbacks.

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
