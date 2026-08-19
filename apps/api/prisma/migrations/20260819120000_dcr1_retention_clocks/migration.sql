-- [DCR-1 NR-2] Retention clocks: the policy registry + sweep receipts.
CREATE TABLE "retention_policies" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "dataClass" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "retainDays" INTEGER NOT NULL,
  "legalBasis" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "retention_policies_dataClass_key" ON "retention_policies"("dataClass");

CREATE TABLE "retention_sweep_receipts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "dataClass" TEXT NOT NULL,
  "cutoff" TIMESTAMP(3) NOT NULL,
  "deleted" INTEGER NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "retention_sweep_receipts_dataClass_ranAt_idx"
  ON "retention_sweep_receipts"("dataClass", "ranAt");
