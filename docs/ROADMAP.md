# Delivery roadmap

The roadmap is ordered by trust dependency. A later phase must not be treated as complete while an earlier security boundary remains simulated.

## Phase 0 — domain kernel

Status: merged.

Delivered mandate creation/revocation, explicit deny precedence, approval-gated actions, deterministic authorization outcomes, signed receipts, and the first HTTP API.

## Phase 1 — contract and invariant hardening

Status: merged.

Delivered payload-bound idempotency, single-use approval consumption, canonical JSON, request correlation, the expanded API contract, and the durable product/architecture/security blueprints.

## Phase 2 — durable multi-tenant and operational core

Status: repository-controlled operational foundation merged through production supervision and recovery proof.

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

Status: merged.

Delivered:

- a hard seven-day replay floor with configurable retention up to 90 days;
- one-shot scheduler-friendly cleanup with no API credential dependency;
- migration-readiness checks without migration authority;
- PostgreSQL `clock_timestamp()` as the retention authority;
- test/live and optional tenant scoping;
- bounded `FOR UPDATE SKIP LOCKED` deletion batches;
- index-aligned candidate ordering for environment-wide cleanup;
- safe count-only structured output;
- bounded expired and eligible backlog sampling after the batch budget is exhausted;
- configuration, migration, source-posture, and real PostgreSQL multi-worker tests.

### Phase 2G — supervised outbox worker

Status: merged.

Delivered:

- a standalone, signal-aware outbox worker process;
- exact trusted local handler modules with no wildcard or remote-module loading;
- PostgreSQL-time claims, leases, retry scheduling, and stale-work recovery;
- bounded `FOR UPDATE SKIP LOCKED` processing across workers;
- append-only attempts and late-owner rejection;
- dead-letter transitions without automatic replay;
- cached bounded backlog samples and low-cardinality metrics;
- loopback-default liveness and readiness endpoints;
- migration 009 and configuration, process, HTTP, and real-PostgreSQL tests.

### Phase 2H — controlled dead-letter replay

Status: merged.

Delivered:

- bounded read-only dead-letter inspection with tenant identity on every result;
- no payload, replay-key hash, request fingerprint, or audit-body disclosure;
- deliberate operator replay with expected-attempt optimistic control;
- payload-bound hashed replay idempotency keys;
- a fresh `PENDING` replacement instead of resetting failed history;
- one direct replacement per source and linear non-forking replay chains;
- immutable replay records and operator audit evidence;
- preserved business-event provenance on replacement messages;
- separate `operator_audit_event_id` provenance on replay records;
- migration 010 and unit, migration, concurrency, and real-PostgreSQL tests.

### Phase 2I — database authority, recovery and production supervision

Status: merged.

Delivered across the production-hardening changes:

- distinct migration, API, expiry-worker, outbox-worker, maintenance and operator database authorities;
- quiesced least-privilege role application with session termination, ownership checks and exact grants;
- a non-root, read-only production image and deployment-neutral Compose reference;
- loopback-default API publication and private worker health/metrics exposure;
- long-running service restart policy, `SIGTERM` shutdown and a 30-second grace period;
- explicit CPU, memory, PID, temporary-storage and local-log bounds;
- snapshot-consistent PostgreSQL custom-format backups using one exported snapshot for manifest and dump;
- disposable `mandate_restore_*` restore drills with SHA-256 and exact migration/critical-state verification;
- real PostgreSQL recovery proof for idempotent HTTP replay, signing-key/receipt verification and outbox/dead-letter continuity;
- deployment-neutral alert baselines tied to emitted API/worker health and metrics;
- incident escalation, rollout/rollback and database-recovery runbooks without choosing a cloud provider.

Repository-controlled Phase 2 operational hardening is therefore closed. Remaining go-live work is deployment-specific rather than missing core machinery:

- TLS termination, firewall/security-group and trusted-proxy enforcement;
- alert/paging backend and centralized log/SIEM wiring;
- production backup schedule, encrypted storage, PITR policy and measured RPO/RTO;
- platform-specific HA/service manifests where required;
- a live dead-letter replay approval/change-control policy;
- external review and ownership of the real outbox delivery handler;
- image vulnerability scanning, SBOM/provenance and release-promotion controls.

These items must be completed for the chosen environment before consequential production use, but they do not justify coupling the core runtime to a vendor prematurely.

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
- migration-readiness check without migration authority;
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
- memory, HTTP, entry-point, and real-PostgreSQL backlog tests;
- restricted production database authority, reference restart/resource/log supervision and initial alert thresholds through Phase 2I.

Remaining deployment-specific work is limited to the chosen platform's service/HA manifest, network enforcement, paging backend, centralized log retention and measured capacity/availability objectives.

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

Status: Phase 4A implemented in the current approval-assignment tranche; Phase 4B is the next product-control dependency after merge.

### Phase 4A — approval assignment model

Status: implemented in this tranche.

Delivered:

- durable tenant/environment-scoped approver identities with active/disabled lifecycle;
- revocable bindings from authenticated API credentials to approver identities, preserving a future OIDC/SSO seam;
- approver groups with history-preserving membership lifecycle;
- direct and group approval assignments with exactly one active assignment per pending approval;
- immutable assignment-time eligibility snapshots so later group additions cannot expand authority over an existing request;
- explicit reassignment that terminates old authority history and creates a fresh snapshot;
- explicit cancellation with authenticated operator evidence and assignment termination;
- separate `approvers:read`, `approvers:write`, `approvals:write`, and `approvals:decide` authorities;
- server-derived decision identity instead of caller-supplied `decidedBy` authority;
- database final-arbiter enforcement that a deciding approver is active and present in the active assignment snapshot;
- immutable eligibility and terminal authority-history constraints;
- recovery-critical backup/restore coverage for approver identities, bindings, groups, memberships, assignments, and eligibility;
- OpenAPI v0.8.0;
- memory adversarial tests and real PostgreSQL concurrency/database-bypass proofs.

Exit gate for 4A:

- a valid API credential alone cannot decide an approval;
- an unassigned or ineligible identity cannot decide;
- a group member added after assignment cannot decide the old request;
- disabling an approver or binding removes live decision authority without rewriting historical evidence;
- concurrent eligible approvers produce one terminal winner;
- legacy free-text decision attribution cannot commit through PostgreSQL after migration 011.

### Phase 4B — approval inbox API

Next dependency.

Scope:

- bounded list/read endpoints optimized for future UI and delivery adapters;
- server-derived eligibility views for the authenticated approver;
- filters for actionable/pending state without exposing unrelated tenant approval traffic;
- safe pagination and tenant/environment isolation;
- no connector-specific semantics in the core inbox resource;
- explicit distinction between administrative approval listing and an approver's actionable inbox.

### Phase 4C — approval expiry/cancellation process

Scope:

- database-time expiry separate from action-attempt expiry;
- durable system evidence;
- bounded claims and multi-worker safety;
- notification/resumption events through the outbox;
- precedence rules among decision, reassignment, cancellation, and expiry.

### Phase 4D — approval evidence

Scope:

- decision comment;
- optional evidence links with bounded validation;
- immutable who/when/why history;
- no secret or arbitrary provider-body persistence.

### Phase 4E — multi-party approval

Only after single-approver/group assignment is proven:

- `1-of-N`;
- `2-of-3` or general threshold;
- unanimous;
- concurrency-safe threshold completion and cancellation/expiry precedence.

Phase 4 exit gate:

- approval notifications are retried through the outbox;
- assignment, decision and consumption are fully auditable;
- expired, cancelled or ineligible approvals cannot authorize an action;
- connector/UI delivery cannot bypass canonical approval state.

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
