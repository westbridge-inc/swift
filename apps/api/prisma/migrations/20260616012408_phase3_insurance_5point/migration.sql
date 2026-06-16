-- Phase 3 — Verification depth: insurance 5-point check (spec §3.4)
-- Additive only.

-- CreateEnum
CREATE TYPE "CoverageClass" AS ENUM ('HIRE', 'PRIVATE');

-- AlterTable
ALTER TABLE "verification_documents" ADD COLUMN     "coverageClass" "CoverageClass",
ADD COLUMN     "hireClassConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "insurerName" TEXT,
ADD COLUMN     "plateCrossChecked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "policyNumber" TEXT;
