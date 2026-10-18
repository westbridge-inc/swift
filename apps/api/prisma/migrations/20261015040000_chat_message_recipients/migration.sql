-- [Row 55 follow-up · owner ruling 14 Oct 2026] Who a chat message was sent to.
--
-- A rider or driver taken off an order can no longer read its chat, so they
-- could not report a message they had received there. The owner ruled that a
-- person who received a message while part of the conversation may still
-- report it. The message now records its recipients when it is written: the
-- conversation's other participants at that moment, under the room lock.
--
-- A constant default: a metadata-only column add, no table rewrite. Messages
-- written before this read as having no recorded recipients, so only people
-- still in the conversation can report them (the rule until now).
SET lock_timeout = '10s';
ALTER TABLE "chat_messages" ADD COLUMN "recipientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
