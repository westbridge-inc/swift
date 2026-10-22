-- [Row 312 · COORD ruling 21 Oct] Uploads stored WITHOUT a malware scan (safety evidence while the
-- scanner was down, or MALWARE_SCAN_BYPASS=1), owed a rescan once clamd answers (lib/upload-scan-debt.ts).
-- No person or tenant id and never the content: a platform-wide ledger, like the scanner itself.
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

    CONSTRAINT "upload_scan_debts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_scan_debts_rescannedAt_createdAt_idx" ON "upload_scan_debts"("rescannedAt", "createdAt");

-- CreateIndex
CREATE INDEX "upload_scan_debts_reason_rescannedAt_idx" ON "upload_scan_debts"("reason", "rescannedAt");

