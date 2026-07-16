-- Supply watcher (availability spec §5)
CREATE TABLE "supply_watches" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    CONSTRAINT "supply_watches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supply_watches_notifiedAt_expiresAt_idx" ON "supply_watches"("notifiedAt", "expiresAt");
CREATE INDEX "supply_watches_customerId_idx" ON "supply_watches"("customerId");
