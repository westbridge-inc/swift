-- [DCR-1 CW] Commencement Watch: scan receipts + deduped alerts.
CREATE TABLE "cw_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "listingHash" TEXT,
  "entriesSeen" INTEGER NOT NULL DEFAULT 0,
  "hits" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "cw_runs_sourceId_ranAt_idx" ON "cw_runs"("sourceId", "ranAt");

CREATE TABLE "cw_alerts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventType" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "matchedRule" TEXT NOT NULL,
  "entryTitle" TEXT NOT NULL,
  "entryUrl" TEXT,
  "contentHash" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notifiedAt" TIMESTAMP(3),
  "acknowledgedBy" TEXT
);
CREATE UNIQUE INDEX "cw_alerts_contentHash_key" ON "cw_alerts"("contentHash");
CREATE INDEX "cw_alerts_eventType_acknowledgedBy_idx" ON "cw_alerts"("eventType", "acknowledgedBy");
