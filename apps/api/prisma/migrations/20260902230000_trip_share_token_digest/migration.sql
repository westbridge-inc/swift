-- [S-16] Trip-share bearer token is stored in plaintext.
-- Only a digest is stored from now on; existing plaintext rows get their digest
-- (dual-read) and are rotated by the tick; the plaintext column is dropped later
-- by an approved migration.
ALTER TABLE "trip_share_tokens" ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "trip_share_tokens" ADD COLUMN "tokenDigest" TEXT;
ALTER TABLE "trip_share_tokens" ADD COLUMN "tokenPrefix" TEXT;
ALTER TABLE "trip_share_tokens" ADD COLUMN "rotatedAt" TIMESTAMP(3);
UPDATE "trip_share_tokens" SET "tokenDigest" = encode(sha256(convert_to("token", 'UTF8')), 'hex'), "tokenPrefix" = left("token", 6) WHERE "token" IS NOT NULL AND "tokenDigest" IS NULL;
CREATE UNIQUE INDEX "trip_share_tokens_tokenDigest_key" ON "trip_share_tokens"("tokenDigest");
