-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StopKind" AS ENUM ('PICKUP', 'DROPOFF');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "delivery_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "riderId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PLANNED',
    "vehicleType" TEXT NOT NULL,
    "capacityPointsUsed" INTEGER NOT NULL DEFAULT 0,
    "cashToCollectTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "plannedDistanceM" INTEGER,
    "plannedDurationS" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_stops" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "StopKind" NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "StopStatus" NOT NULL DEFAULT 'PENDING',
    "plannedEta" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cashToCollect" DECIMAL(12,2),
    "changeFor" DECIMAL(12,2),

    CONSTRAINT "run_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_evaluations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "riderId" TEXT,
    "runId" TEXT,
    "decision" TEXT NOT NULL,
    "rulesChecked" JSONB NOT NULL,
    "scoreBreakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batching_settings" (
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "shadowMode" BOOLEAN NOT NULL DEFAULT true,
    "maxOrdersPerRun" INTEGER NOT NULL DEFAULT 2,
    "addonPickupDetourMaxS" INTEGER NOT NULL DEFAULT 300,
    "dropoffCorridorM" INTEGER NOT NULL DEFAULT 1500,
    "crossTrackMaxM" INTEGER NOT NULL DEFAULT 800,
    "detourBudgetS" INTEGER NOT NULL DEFAULT 480,
    "detourBudgetPct" INTEGER NOT NULL DEFAULT 25,
    "hotFoodReadyToDoorMaxS" INTEGER NOT NULL DEFAULT 1500,
    "pickupWaitMaxS" INTEGER NOT NULL DEFAULT 300,
    "verticalMatrix" JSONB,
    "sizePoints" JSONB,
    "capacityPointsByVehicle" JSONB,
    "addonScanIntervalS" INTEGER NOT NULL DEFAULT 20,

    CONSTRAINT "batching_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "delivery_runs_riderId_status_idx" ON "delivery_runs"("riderId", "status");

-- CreateIndex
CREATE INDEX "delivery_runs_tenantId_status_idx" ON "delivery_runs"("tenantId", "status");

-- CreateIndex
CREATE INDEX "run_stops_orderId_idx" ON "run_stops"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "run_stops_runId_seq_key" ON "run_stops"("runId", "seq");

-- CreateIndex
CREATE INDEX "batch_evaluations_orderId_idx" ON "batch_evaluations"("orderId");

-- CreateIndex
CREATE INDEX "batch_evaluations_tenantId_createdAt_idx" ON "batch_evaluations"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "run_stops" ADD CONSTRAINT "run_stops_runId_fkey" FOREIGN KEY ("runId") REFERENCES "delivery_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

