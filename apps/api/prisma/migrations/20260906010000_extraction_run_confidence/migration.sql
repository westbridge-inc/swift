-- [DOC-1 §6.9 · P6-4] Processor-reported confidence for the extracted set, on the
-- run. NULL = unknown, which is never eligible for auto-approval.

-- AlterTable
ALTER TABLE "extraction_run" ADD COLUMN "confidence" DECIMAL(4,3);
