-- CreateEnum
CREATE TYPE "RlpReserveEntryKind" AS ENUM ('PROVISION', 'PAYOUT', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "reimbursement_claims" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "evidenceComplete" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lossProtectionSuspendedAt" TIMESTAMP(3),
ADD COLUMN     "lossProtectionSuspendedReason" TEXT;

-- CreateTable
CREATE TABLE "rlp_reserve_entries" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "kind" "RlpReserveEntryKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "periodKey" TEXT,
    "claimId" TEXT,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rlp_reserve_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rlp_reserve_entries_claimId_key" ON "rlp_reserve_entries"("claimId");

-- CreateIndex
CREATE INDEX "rlp_reserve_entries_countryCode_createdAt_idx" ON "rlp_reserve_entries"("countryCode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "rlp_reserve_entries_countryCode_kind_periodKey_key" ON "rlp_reserve_entries"("countryCode", "kind", "periodKey");

-- AddForeignKey
ALTER TABLE "rlp_reserve_entries" ADD CONSTRAINT "rlp_reserve_entries_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "reimbursement_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- [DOC-1 §31.4 · P31-1] The reserve never goes below zero: a payout is drawn from a
-- funded line or refused. The advisory lock serialises concurrent draws per country so
-- two payouts cannot both see the same balance. Mirrored verbatim by rlpReserveDdl().
CREATE OR REPLACE FUNCTION rlp_reserve_nonnegative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal NUMERIC;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('rlp_reserve:' || NEW."countryCode"));
  SELECT COALESCE(SUM(amount), 0) INTO bal FROM rlp_reserve_entries WHERE "countryCode" = NEW."countryCode";
  IF bal < 0 THEN
    RAISE EXCEPTION 'RLP_RESERVE_UNFUNDED: the % loss-protection reserve would stand at % after this entry', NEW."countryCode", bal USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rlp_reserve_entries_nonnegative ON rlp_reserve_entries;
CREATE TRIGGER rlp_reserve_entries_nonnegative AFTER INSERT OR UPDATE OF amount, "countryCode" ON rlp_reserve_entries FOR EACH ROW EXECUTE FUNCTION rlp_reserve_nonnegative();
