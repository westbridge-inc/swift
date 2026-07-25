-- STORE-001: UGC content reporting + moderation queue (store-compliance §5.4).
-- Additive — new enums + table only.
CREATE TYPE "ReportTargetType" AS ENUM ('RATING', 'CHAT_MESSAGE', 'USER', 'VENDOR', 'ITEM');
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'SEXUAL_CONTENT', 'CSAE', 'ILLEGAL_GOODS', 'OTHER');
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'REVIEWING', 'ACTIONED', 'DISMISSED');

CREATE TABLE "content_reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "detail" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "content_reports_reporterId_targetType_targetId_key" ON "content_reports"("reporterId", "targetType", "targetId");
CREATE INDEX "content_reports_status_createdAt_idx" ON "content_reports"("status", "createdAt");
CREATE INDEX "content_reports_targetType_targetId_idx" ON "content_reports"("targetType", "targetId");
