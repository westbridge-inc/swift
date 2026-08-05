-- CreateEnum
CREATE TYPE "RatingState" AS ENUM ('ACTIVE', 'EXCLUDED', 'REMOVED');

-- AlterTable
ALTER TABLE "ratings" ADD COLUMN     "contextId" TEXT,
ADD COLUMN     "contextType" TEXT,
ADD COLUMN     "editableUntil" TIMESTAMP(3),
ADD COLUMN     "state" "RatingState" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "stateReason" TEXT;

-- CreateTable
CREATE TABLE "actor_rating_stats" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "subjectRole" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "lifetimeCount" INTEGER NOT NULL DEFAULT 0,
    "lifetimeSum" INTEGER NOT NULL DEFAULT 0,
    "rollingCount" INTEGER NOT NULL DEFAULT 0,
    "rollingSum" INTEGER NOT NULL DEFAULT 0,
    "displayRating" DECIMAL(2,1),
    "standing" TEXT NOT NULL DEFAULT 'NEW',
    "topPositiveTags" JSONB NOT NULL DEFAULT '[]',
    "topNegativeTags" JSONB NOT NULL DEFAULT '[]',
    "actorVisibleAt" TIMESTAMP(3),
    "recomputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actor_rating_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating_reports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "ratingId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_feedbacks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "raterUserId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating_tag_defs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "role" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "isSeed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "rating_tag_defs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "actor_rating_stats_tenantId_subjectRole_subjectId_key" ON "actor_rating_stats"("tenantId", "subjectRole", "subjectId");

-- CreateIndex
CREATE INDEX "rating_reports_tenantId_status_idx" ON "rating_reports"("tenantId", "status");

-- CreateIndex
CREATE INDEX "item_feedbacks_tenantId_itemId_verdict_idx" ON "item_feedbacks"("tenantId", "itemId", "verdict");

-- CreateIndex
CREATE UNIQUE INDEX "item_feedbacks_orderId_itemId_raterUserId_key" ON "item_feedbacks"("orderId", "itemId", "raterUserId");

-- CreateIndex
CREATE UNIQUE INDEX "rating_tag_defs_tenantId_role_slug_key" ON "rating_tag_defs"("tenantId", "role", "slug");

-- CreateIndex
CREATE INDEX "ratings_state_idx" ON "ratings"("state");

