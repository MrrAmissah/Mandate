# Database backup and recovery drills

Mandate database recovery is an operator-controlled workflow. It does not create, drop, or rename databases and does not embed cloud-provider assumptions.

## Security boundary

- Run backup and restore commands with dedicated database identities, not API or worker credentials.
- Supply PostgreSQL credentials through environment or secret files; the tooling passes the connection URL through `PGDATABASE`, never as a command argument.
- Store backup artifacts outside the repository on encrypted durable storage.
- Backup output directories must be absolute and should be mounted with access restricted to the backup operator.
- Restore targets must already exist and must use the `mandate_restore_` prefix.
- Never point a restore drill at production, staging, or another long-lived database.
- The restore command does not drop or create a database. Database lifecycle remains an explicit infrastructure responsibility.

## Create a backup

The host or container running this command must provide a compatible `pg_dump` executable.

```bash
DATABASE_URL_FILE=/run/secrets/mandate_backup_database_url \
MANDATE_BACKUP_OUTPUT_DIR=/var/backups/mandate \
MANDATE_BACKUP_LABEL=nightly-2026-08-01 \
npm run database:backup
```

When the process environment is prepared directly rather than by the production entrypoint, set `DATABASE_URL` instead of `DATABASE_URL_FILE`.

The command:

1. verifies migration `010_outbox_dead_letter_replays`;
2. captures the ordered migration registry and critical-table row counts;
3. writes a PostgreSQL custom-format dump to a temporary file;
4. applies mode `0600`;
5. verifies the artifact is non-empty;
6. calculates SHA-256;
7. atomically publishes the dump;
8. writes a mode-`0600` JSON manifest next to it.

Existing destination names fail closed. Partial artifacts are removed after failure.

## Run a restore drill

Create a disposable empty database using infrastructure-controlled credentials. Its name must begin with `mandate_restore_`.

```bash
MANDATE_RECOVERY_TARGET_URL_FILE=/run/secrets/mandate_restore_database_url \
MANDATE_RECOVERY_BACKUP_PATH=/var/backups/mandate/mandate-nightly-2026-08-01.dump \
npm run database:restore-drill
```

When running outside the production entrypoint, set `MANDATE_RECOVERY_TARGET_URL` directly.

The drill:

1. verifies the manifest belongs to the selected artifact;
2. recalculates and compares SHA-256 before restore;
3. runs `pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges` against the explicitly disposable target;
4. reloads the migration registry;
5. verifies exact row counts for tenants, credentials, mandates, approvals, decisions, action attempts, receipts, audit events, outbox messages, and signing keys.

A successful count comparison is a recovery-integrity baseline, not a substitute for application-level smoke tests. After each drill, operators should also start the API and workers against the restored target with non-production credentials and verify readiness, historical receipt verification, audit pagination, and outbox backlog inspection.

## Scheduling and retention

The repository deliberately does not choose a backup provider, cadence, retention policy, encryption service, or geographic replication policy. Production owners must define these based on data-classification, RPO/RTO, regulatory, and incident-response requirements.

Minimum operational evidence for each drill:

- source environment and backup label;
- artifact SHA-256 and protected storage location;
- backup start/end time and size;
- disposable restore database identity;
- restore start/end time;
- verification result and safe error code on failure;
- operator identity and incident/change reference;
- cleanup confirmation for the disposable database.

Do not commit dumps, manifests containing production counts, credentials, or drill logs to the repository.
