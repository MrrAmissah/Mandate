# Database backup and recovery drills

Mandate database recovery is an operator-controlled workflow. It does not create, drop, or rename databases and does not embed cloud-provider assumptions.

## Security boundary

- Run backup and restore commands with dedicated database identities, not API or worker credentials.
- Supply PostgreSQL credentials through environment or secret files. The tooling decomposes the connection URL into libpq `PG*` environment variables and never places a password or full connection URL in a process argument.
- Store backup artifacts outside the repository on encrypted durable storage.
- Backup output directories must be absolute and should be mounted with access restricted to the backup operator.
- Restore targets must already exist and must use the `mandate_restore_` prefix.
- Never point a restore drill at production, staging, or another long-lived database.
- The restore command does not drop or create a database. Database lifecycle remains an explicit infrastructure responsibility.
- Set `MANDATE_DATABASE_SSL=true` when the database requires TLS unless the PostgreSQL URL already supplies an explicit `sslmode`.

## Create a backup

The host or container running this command must provide a compatible `pg_dump` executable.

```bash
DATABASE_URL_FILE=/run/secrets/mandate_backup_database_url \
MANDATE_BACKUP_OUTPUT_DIR=/var/backups/mandate \
MANDATE_BACKUP_LABEL=nightly-2026-08-01 \
MANDATE_DATABASE_SSL=true \
npm run database:backup
```

When the process environment is prepared directly rather than by the production entrypoint, set `DATABASE_URL` instead of `DATABASE_URL_FILE`.

The command:

1. verifies migration `010_outbox_dead_letter_replays`;
2. opens one read-only repeatable-read transaction and exports its PostgreSQL snapshot;
3. captures the ordered migration registry and critical durable-state row counts inside that snapshot;
4. gives the same exported snapshot to `pg_dump`, so the manifest and dump describe the same recovery point even while normal writes continue;
5. writes a PostgreSQL custom-format dump to a unique temporary file;
6. applies mode `0600` and verifies the artifact is non-empty;
7. calculates SHA-256;
8. atomically publishes the dump and then its mode-`0600` JSON manifest.

The dump and manifest names are reserved exclusively before database work begins and remain reserved through publication. A concurrent process using the same label fails closed instead of sharing a `.partial` path or overwriting another backup. A failed invocation removes only artifacts it reserved or created.

## Run a restore drill

Create a disposable empty database using infrastructure-controlled credentials. Its name must begin with `mandate_restore_`.

```bash
MANDATE_RECOVERY_TARGET_URL_FILE=/run/secrets/mandate_restore_database_url \
MANDATE_RECOVERY_BACKUP_PATH=/var/backups/mandate/mandate-nightly-2026-08-01.dump \
MANDATE_DATABASE_SSL=true \
npm run database:restore-drill
```

The production entrypoint resolves both `DATABASE_URL_FILE` and `MANDATE_RECOVERY_TARGET_URL_FILE`. When running outside that entrypoint, set the corresponding direct environment variable instead.

The drill:

1. verifies the manifest belongs to the selected artifact;
2. recalculates and compares SHA-256 before restore;
3. runs `pg_restore` in direct-database mode against only the explicitly disposable target, with `--clean --if-exists --exit-on-error --no-owner --no-privileges`;
4. reloads the migration registry;
5. verifies exact row counts for tenants, credentials, mandates, approvals, authorization decisions, action attempts, receipts, idempotency records, audit sequence/evidence, outbox messages/attempts/dead-letter replay evidence, and signing keys.

The PostgreSQL CI drill goes beyond row counts. It creates an isolated source database, performs a normal idempotent Mandate API mutation, registers a real Ed25519 signing key, stores a signed receipt, and records dead-letter evidence. During backup it performs another source write only after the exported snapshot exists. After restoring into a fresh `mandate_restore_*` database, CI proves that:

- the post-snapshot write is absent, demonstrating that dump and manifest use one recovery point;
- the original idempotent API request replays the same stored response;
- the restored receipt verifies against the restored signing-key registry;
- the dead-letter message and append-only delivery attempt retain their terminal evidence;
- the migration registry and all inventoried critical counts match the manifest exactly.

These checks are a repository-level recovery proof, not a production RPO/RTO claim. Production owners still need scheduled provider backups, protected storage, restore exercises using production-equivalent infrastructure, and measured recovery timing.

## Scheduling and retention

The repository deliberately does not choose a backup provider, cadence, retention policy, encryption service, or geographic replication policy. Production owners must define these based on data classification, RPO/RTO, regulatory, and incident-response requirements.

Minimum operational evidence for each drill:

- source environment and backup label;
- artifact SHA-256 and protected storage location;
- backup start/end time and size;
- disposable restore database identity;
- restore start/end time;
- verification result and safe error code on failure;
- application-level replay/receipt/outbox verification result;
- operator identity and incident/change reference;
- cleanup confirmation for the disposable database.

Do not commit dumps, manifests containing production counts, credentials, or drill logs to the repository.
