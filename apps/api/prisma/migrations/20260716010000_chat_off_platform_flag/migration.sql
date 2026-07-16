-- Off-platform contact signal on chat messages (marketplace-mechanics §2)
ALTER TABLE "chat_messages" ADD COLUMN "offPlatformFlag" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "chat_messages_offPlatformFlag_idx" ON "chat_messages"("offPlatformFlag");
