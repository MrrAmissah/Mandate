BEGIN;

DROP TRIGGER IF EXISTS outbox_messages_replay_link_guard ON mandate.outbox_messages;
DROP FUNCTION IF EXISTS mandate.guard_outbox_replay_link();
DROP TABLE IF EXISTS mandate.outbox_dead_letter_replays;
DROP INDEX IF EXISTS mandate.outbox_dead_letter_unreplayed_idx;
DROP INDEX IF EXISTS mandate.outbox_dead_letter_replayed_idx;
DROP INDEX IF EXISTS mandate.outbox_messages_replay_target_unique;
ALTER TABLE mandate.outbox_messages
  DROP CONSTRAINT IF EXISTS outbox_messages_replay_shape,
  DROP CONSTRAINT IF EXISTS outbox_messages_replay_target_fk,
  DROP COLUMN IF EXISTS replay_message_id;
DELETE FROM mandate.schema_migrations WHERE version = '010_outbox_dead_letter_replays';

COMMIT;
