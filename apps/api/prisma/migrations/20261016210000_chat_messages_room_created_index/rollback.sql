-- [Row 310] The index holds no data: dropping it changes no result, only the
-- plan (chat polling goes back to reading the whole table). No code depends on
-- it by name.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS "chat_messages_chatRoomId_createdAt_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016210000_chat_messages_room_created_index';
COMMIT;
