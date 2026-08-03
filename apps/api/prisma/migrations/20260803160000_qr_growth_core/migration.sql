-- CreateEnum
CREATE TYPE "QrEntityType" AS ENUM ('VENDOR');

-- CreateEnum
CREATE TYPE "QrStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ScanDecision" AS ENUM ('WEB_RENDER', 'APP_OPEN_ASSUMED', 'RETIRED_PAGE', 'UNAVAILABLE_PAGE', 'NOT_FOUND');

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "entityType" "QrEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "QrStatus" NOT NULL DEFAULT 'ACTIVE',
    "styleTemplate" TEXT NOT NULL DEFAULT 'standard',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "qrCodeId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "ScanDecision" NOT NULL,
    "src" TEXT,
    "template" TEXT,
    "osFamily" TEXT,
    "deviceClass" TEXT,
    "uaHash" TEXT,
    "ipHash" TEXT,
    "country" TEXT,
    "sessionId" TEXT,

    CONSTRAINT "scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slug_redirects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "entityType" "QrEntityType" NOT NULL,
    "oldSlug" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slug_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_daily_rollups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "qrCodeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "decision" "ScanDecision" NOT NULL,
    "osFamily" TEXT,
    "template" TEXT,
    "count" INTEGER NOT NULL,

    CONSTRAINT "scan_daily_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qr_codes_shortCode_key" ON "qr_codes"("shortCode");

-- CreateIndex
CREATE INDEX "qr_codes_tenantId_entityType_entityId_idx" ON "qr_codes"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "qr_codes_tenantId_status_idx" ON "qr_codes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "scan_events_tenantId_qrCodeId_occurredAt_idx" ON "scan_events"("tenantId", "qrCodeId", "occurredAt");

-- CreateIndex
CREATE INDEX "scan_events_occurredAt_idx" ON "scan_events"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "slug_redirects_tenantId_entityType_oldSlug_key" ON "slug_redirects"("tenantId", "entityType", "oldSlug");

-- CreateIndex
CREATE INDEX "scan_daily_rollups_tenantId_qrCodeId_date_idx" ON "scan_daily_rollups"("tenantId", "qrCodeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "scan_daily_rollups_tenantId_qrCodeId_date_decision_osFamily_key" ON "scan_daily_rollups"("tenantId", "qrCodeId", "date", "decision", "osFamily", "template");

-- AddForeignKey
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "qr_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One ACTIVE code per entity — the get-or-create/regenerate concurrency guard.
-- Partial by design (SUPERSEDED/DEACTIVATED history coexists); Prisma cannot
-- express partial uniques, so this raw index is the source of truth and the
-- test suite self-installs it idempotently (established pattern).
CREATE UNIQUE INDEX IF NOT EXISTS "one_active_qr_per_entity"
  ON "qr_codes"("tenantId", "entityType", "entityId") WHERE status = 'ACTIVE';
