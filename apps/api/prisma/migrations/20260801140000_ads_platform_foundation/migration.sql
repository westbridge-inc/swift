-- CreateEnum
CREATE TYPE "AdvertiserStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AdvertiserMemberRole" AS ENUM ('OWNER', 'MANAGER', 'ANALYST');

-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdCreativeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdTranscodeStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AdBookingStatus" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AdInvoiceStatus" AS ENUM ('UNPAID', 'PAID', 'VOID', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "AdMediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "AdEventType" AS ENUM ('IMPRESSION', 'VIEWABLE_IMPRESSION', 'CLICK', 'VIDEO_START', 'VIDEO_Q25', 'VIDEO_Q50', 'VIDEO_Q75', 'VIDEO_COMPLETE');

-- CreateEnum
CREATE TYPE "AdDestinationType" AS ENUM ('NONE', 'URL', 'DEEPLINK');

-- CreateTable
CREATE TABLE "advertisers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "companyName" TEXT NOT NULL,
    "legalName" TEXT,
    "registrationNo" TEXT,
    "industry" TEXT NOT NULL,
    "website" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "city" TEXT,
    "status" "AdvertiserStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "statusReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advertisers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertiser_members" (
    "advertiserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "AdvertiserMemberRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advertiser_members_pkey" PRIMARY KEY ("advertiserId","userId")
);

-- CreateTable
CREATE TABLE "ad_placements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "mediaKind" "AdMediaKind" NOT NULL,
    "slotsPerWeek" INTEGER NOT NULL DEFAULT 1,
    "rotationSeconds" INTEGER,
    "weeklyPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GYD',
    "freqCapPerUserPerDay" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ad_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_inventory_weeks" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '*',
    "weekStart" DATE NOT NULL,
    "capacity" INTEGER NOT NULL,
    "booked" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ad_inventory_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_campaigns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "advertiserId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "cities" TEXT[],
    "startWeek" DATE NOT NULL,
    "endWeek" DATE NOT NULL,
    "destinationType" "AdDestinationType" NOT NULL DEFAULT 'NONE',
    "destinationValue" TEXT,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "totalAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'GYD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_creatives" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "AdMediaKind" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "posterUrl" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DECIMAL(6,2),
    "sizeBytes" BIGINT,
    "headline" TEXT,
    "body" TEXT,
    "ctaLabel" TEXT,
    "transcodeStatus" "AdTranscodeStatus" NOT NULL DEFAULT 'READY',
    "status" "AdCreativeStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNotes" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_bookings" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '*',
    "weekStart" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "AdBookingStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedUntil" TIMESTAMP(3),

    CONSTRAINT "ad_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "advertiserId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GYD',
    "status" "AdInvoiceStatus" NOT NULL DEFAULT 'UNPAID',
    "provider" TEXT,
    "providerRef" TEXT,
    "paymentUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_events" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "campaignId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "placementKey" TEXT NOT NULL,
    "city" TEXT,
    "eventType" "AdEventType" NOT NULL,
    "userHash" TEXT,
    "sessionId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenHash" TEXT NOT NULL,
    "meta" JSONB,

    CONSTRAINT "ad_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_event_dedupe" (
    "tokenHash" TEXT NOT NULL,
    "eventType" "AdEventType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_event_dedupe_pkey" PRIMARY KEY ("tokenHash","eventType")
);

-- CreateTable
CREATE TABLE "ad_freq_counters" (
    "userHash" TEXT NOT NULL,
    "placementKey" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ad_freq_counters_pkey" PRIMARY KEY ("userHash","placementKey","day")
);

-- CreateTable
CREATE TABLE "ad_stats_daily" (
    "campaignId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "city" TEXT NOT NULL DEFAULT '*',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "viewableImpressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "videoStarts" INTEGER NOT NULL DEFAULT 0,
    "videoCompletes" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ad_stats_daily_pkey" PRIMARY KEY ("campaignId","creativeId","day","city")
);

-- CreateTable
CREATE TABLE "house_ads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "placementId" TEXT NOT NULL,
    "kind" "AdMediaKind" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "posterUrl" TEXT,
    "headline" TEXT,
    "ctaLabel" TEXT,
    "destinationType" "AdDestinationType" NOT NULL DEFAULT 'NONE',
    "destinationValue" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "house_ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads_settings" (
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "reservationMinutes" INTEGER NOT NULL DEFAULT 20,
    "reviewSlaHours" INTEGER NOT NULL DEFAULT 24,
    "cancelFullRefundDays" INTEGER NOT NULL DEFAULT 7,
    "autoCancelUnapprovedHours" INTEGER NOT NULL DEFAULT 24,
    "weekTimezone" TEXT NOT NULL DEFAULT 'America/Guyana',
    "defaultRotationSeconds" INTEGER NOT NULL DEFAULT 6,
    "platformFeePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "restrictedCategories" JSONB,

    CONSTRAINT "ads_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "ads_audit_log" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "advertisers_tenantId_status_idx" ON "advertisers"("tenantId", "status");

-- CreateIndex
CREATE INDEX "advertiser_members_userId_idx" ON "advertiser_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ad_placements_tenantId_key_key" ON "ad_placements"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ad_inventory_weeks_placementId_city_weekStart_key" ON "ad_inventory_weeks"("placementId", "city", "weekStart");

-- CreateIndex
CREATE INDEX "ad_campaigns_tenantId_status_idx" ON "ad_campaigns"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ad_campaigns_placementId_status_idx" ON "ad_campaigns"("placementId", "status");

-- CreateIndex
CREATE INDEX "ad_campaigns_advertiserId_status_idx" ON "ad_campaigns"("advertiserId", "status");

-- CreateIndex
CREATE INDEX "ad_creatives_status_idx" ON "ad_creatives"("status");

-- CreateIndex
CREATE INDEX "ad_bookings_placementId_city_weekStart_status_idx" ON "ad_bookings"("placementId", "city", "weekStart", "status");

-- CreateIndex
CREATE INDEX "ad_bookings_status_reservedUntil_idx" ON "ad_bookings"("status", "reservedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ad_bookings_campaignId_placementId_city_weekStart_key" ON "ad_bookings"("campaignId", "placementId", "city", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "ad_invoices_number_key" ON "ad_invoices"("number");

-- CreateIndex
CREATE INDEX "ad_invoices_tenantId_status_idx" ON "ad_invoices"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ad_invoices_providerRef_idx" ON "ad_invoices"("providerRef");

-- CreateIndex
CREATE INDEX "ad_events_campaignId_occurredAt_idx" ON "ad_events"("campaignId", "occurredAt");

-- CreateIndex
CREATE INDEX "ad_events_occurredAt_idx" ON "ad_events"("occurredAt");

-- CreateIndex
CREATE INDEX "house_ads_tenantId_placementId_active_idx" ON "house_ads"("tenantId", "placementId", "active");

-- CreateIndex
CREATE INDEX "ads_audit_log_tenantId_createdAt_idx" ON "ads_audit_log"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "advertiser_members" ADD CONSTRAINT "advertiser_members_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_inventory_weeks" ADD CONSTRAINT "ad_inventory_weeks_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ad_placements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ad_placements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_bookings" ADD CONSTRAINT "ad_bookings_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_invoices" ADD CONSTRAINT "ad_invoices_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_invoices" ADD CONSTRAINT "ad_invoices_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_ads" ADD CONSTRAINT "house_ads_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ad_placements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Invariant CHECK constraints (ads-platform spec §5 migration additions) ──
-- booked can never exceed capacity or go negative (the reservation engine's
-- row-lock guards the race; this is the last-line DB backstop).
ALTER TABLE "ad_inventory_weeks" ADD CONSTRAINT "ad_inventory_weeks_booked_range" CHECK ("booked" >= 0 AND "booked" <= "capacity");

-- Every ad week boundary is a Monday in tenant TZ (ISODOW 1) — week math
-- everywhere assumes it, so the DB refuses a non-Monday.
ALTER TABLE "ad_inventory_weeks" ADD CONSTRAINT "ad_inventory_weeks_monday" CHECK (EXTRACT(ISODOW FROM "weekStart") = 1);
ALTER TABLE "ad_bookings" ADD CONSTRAINT "ad_bookings_monday" CHECK (EXTRACT(ISODOW FROM "weekStart") = 1);
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_weeks_monday" CHECK (EXTRACT(ISODOW FROM "startWeek") = 1 AND EXTRACT(ISODOW FROM "endWeek") = 1);
