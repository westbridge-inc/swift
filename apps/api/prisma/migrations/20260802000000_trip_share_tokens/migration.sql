-- Safety spec §6: Trip Share — tokenized public live-trip page. Additive.
CREATE TABLE "trip_share_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sharedToPhone" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_share_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trip_share_tokens_token_key" ON "trip_share_tokens"("token");
CREATE INDEX "trip_share_tokens_orderId_idx" ON "trip_share_tokens"("orderId");

ALTER TABLE "trip_share_tokens" ADD CONSTRAINT "trip_share_tokens_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
