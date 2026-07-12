-- Refresh rotation theft detection: remember the token each rotation replaced
-- (and when) so a replay of a consumed refresh token can be told apart from a
-- benign concurrent retry and treated as credential theft.
ALTER TABLE "sessions" ADD COLUMN "previousRefreshToken" TEXT;
ALTER TABLE "sessions" ADD COLUMN "rotatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "sessions_previousRefreshToken_key" ON "sessions"("previousRefreshToken");
