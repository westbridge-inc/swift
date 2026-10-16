-- [Row 55 follow-up] Rolling this back means a person taken off an order can
-- no longer report a chat message they received there. Roll back the code that
-- writes and reads the column (chat.routes.ts send, moderation.routes.ts
-- reports) first or together. Nothing else references the column.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "recipientIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015040000_chat_message_recipients';
COMMIT;
