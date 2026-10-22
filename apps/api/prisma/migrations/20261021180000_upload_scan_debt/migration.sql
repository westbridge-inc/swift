-- [Row 312 · COORD rulings 21-22 Oct] Uploads stored WITHOUT a clean malware scan (evidence, held in the
-- quarantine until a clean scan releases it; or MALWARE_SCAN_BYPASS=1), owed a rescan once clamd answers
-- (lib/upload-scan-debt.ts). No person or tenant id and never the content: a platform-wide ledger, like
-- the scanner itself. An object key is a storage path and can embed an owner's id (a bypass row forgets
-- it when it closes clean; an evidence row keeps its order-folder key as the map to its released bytes).
SET lock_timeout = '10s';

-- CreateTable
CREATE TABLE "upload_scan_debts" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "fileKey" TEXT,
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "sha256" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rescannedAt" TIMESTAMP(3),
    "result" TEXT,
    "signature" TEXT,
    "quarantinedAt" TIMESTAMP(3),
    "quarantineKey" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedKey" TEXT,

    CONSTRAINT "upload_scan_debts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_scan_debts_rescannedAt_createdAt_idx" ON "upload_scan_debts"("rescannedAt", "createdAt");

-- CreateIndex
CREATE INDEX "upload_scan_debts_reason_rescannedAt_idx" ON "upload_scan_debts"("reason", "rescannedAt");

-- CreateIndex
CREATE INDEX "upload_scan_debts_fileKey_idx" ON "upload_scan_debts"("fileKey");
