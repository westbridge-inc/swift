-- [GUARDRAILS §8] Prohibited items (owner, 13 Oct 2026). Nullable columns only:
-- every existing row reads as "not removed, never approved", which is exactly
-- the state the new rule starts from (a word hit is held until a person checks it).

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "prohibitedAt" TIMESTAMP(3),
ADD COLUMN     "prohibitedClass" TEXT,
ADD COLUMN     "prohibitedReason" TEXT,
ADD COLUMN     "reviewApprovedAt" TIMESTAMP(3),
ADD COLUMN     "reviewApprovedHash" TEXT;
