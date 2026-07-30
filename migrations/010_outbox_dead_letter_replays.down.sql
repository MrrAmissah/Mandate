BEGIN;

DELETE FROM mandate.schema_migrations WHERE version = '010_outbox_dead_letter_replays';
DROP TABLE IF EXISTS mandate.outbox_dead_letter_replays;

COMMIT;
