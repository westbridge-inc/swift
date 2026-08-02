-- Rides spec 5.5B (additive): the supply-gap queue table.
-- Rollback: DROP TABLE "ride_queue_entries";
CREATE TABLE "ride_queue_entries" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tenantId" TEXT,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "dropoffLat" DOUBLE PRECISION NOT NULL,
    "dropoffLng" DOUBLE PRECISION NOT NULL,
    "dropoffAddress" TEXT NOT NULL,
    "rideClass" TEXT NOT NULL DEFAULT 'ECONOMY',
    "passengerCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "matchedOrderId" TEXT,
    "expiredNotifiedAt" TIMESTAMP(3),
    CONSTRAINT "ride_queue_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ride_queue_entries_status_expiresAt_idx" ON "ride_queue_entries"("status", "expiresAt");
CREATE INDEX "ride_queue_entries_customerId_status_idx" ON "ride_queue_entries"("customerId", "status");
