-- [DOC-1 §6.9 · P6-4] The always-review set is a registry FACT, not a code literal
-- (DOC-INV-2): the insurance certificate carries it at launch (FD-DOC-6).

-- AlterTable
ALTER TABLE "doc_type" ADD COLUMN "alwaysReview" BOOLEAN NOT NULL DEFAULT false;

UPDATE "doc_type" SET "alwaysReview" = true WHERE "legacyCode" = 'vehicle_insurance';
