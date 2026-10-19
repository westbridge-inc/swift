-- [Row 310] Chat polling reads one room's newest messages
-- (WHERE "chatRoomId" = $1 ORDER BY "createdAt" DESC LIMIT n) every few
-- seconds per open chat, and chat_messages had only an index on
-- "offPlatformFlag": every poll read the whole table. This index serves the
-- poll, the older-page read, the split-code lookback (same room, one sender)
-- and the safety evidence export.
--
-- Built ONLINE: a plain CREATE INDEX holds a SHARE lock that blocks every chat
-- write for the whole build. Keep this file to exactly ONE PostgreSQL
-- statement: Prisma submits a multi-statement migration as an implicit
-- transaction, where CREATE INDEX CONCURRENTLY is forbidden (precedent
-- 20260925000410). That is also why there is no SET lock_timeout here: it
-- would be a second statement. CONCURRENTLY takes only a SHARE UPDATE
-- EXCLUSIVE lock, which reads and writes do not wait for.
-- An interrupted build leaves an INVALID index: drop it, then rerun this
-- migration (IF NOT EXISTS on its own would keep the invalid one).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_messages_chatRoomId_createdAt_idx"
ON "chat_messages"("chatRoomId", "createdAt");
