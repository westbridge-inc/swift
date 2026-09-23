-- [ORDER-SPINE S1-6] Direct-MMG claim authority: the customer's statement is
-- durable, every claim transition advances one generation counter, and an
-- operator decision names the generation it reviewed. EXPAND only: two enums,
-- six columns with defaults (metadata-only on PostgreSQL 11+), four CHECKs.
--
-- The CHECKs are the point. `chk_orders_mmg_disagreement_held` makes the
-- finding-6 end state unwritable by ANY writer: a store claim (CLAIMED) or a
-- provider capture (CAPTURED) contradicted by the customer's durable "I did not
-- pay" — or by a different payment reference — must carry an open disagreement
-- (`mmgClaimMismatchAt`, the latch every fulfilment gate already reads) unless
-- an operator's CUSTOMER_PAID decision covers exactly the current generation.
-- Every existing row is UNRECORDED / revision 0 / undecided, so all four hold
-- for existing data and validate immediately.
--
-- ROLLBACK (never while the new application writes these columns; forward
-- repair is preferred). The guard refuses whenever recorded claim evidence
-- would be discarded — dropping a customer's recorded "I did not pay" is
-- exactly the defect this migration closes:
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "orders" WHERE "customerMmgClaim" <> 'UNRECORDED'
--                OR "mmgClaimRevision" <> 0 OR "mmgClaimResolution" IS NOT NULL) THEN
--       RAISE EXCEPTION 'refusing rollback: recorded direct-MMG claim evidence would be discarded';
--     END IF;
--   END $$;
--   ALTER TABLE "orders" DROP CONSTRAINT "chk_orders_mmg_disagreement_held",
--     DROP CONSTRAINT "chk_orders_mmg_claim_resolution_shape",
--     DROP CONSTRAINT "chk_orders_customer_mmg_claim_shape",
--     DROP CONSTRAINT "chk_orders_mmg_claim_revision_nonneg";
--   ALTER TABLE "orders" DROP COLUMN "mmgClaimRevision", DROP COLUMN "mmgClaimResolvedRevision",
--     DROP COLUMN "mmgClaimResolvedAt", DROP COLUMN "mmgClaimResolution",
--     DROP COLUMN "customerMmgClaimAt", DROP COLUMN "customerMmgClaim";
--   DROP TYPE "MmgClaimResolution";
--   DROP TYPE "CustomerMmgClaim";
-- (apps/api/MMG-CLAIM-DISAGREEMENT-CUTOVER.md carries the executable form — one
-- transaction, including the migration-history row — and the writer-cutover rules.)

-- CreateEnum
CREATE TYPE "CustomerMmgClaim" AS ENUM ('UNRECORDED', 'PAID', 'NOT_PAID');

-- CreateEnum
CREATE TYPE "MmgClaimResolution" AS ENUM ('CUSTOMER_PAID', 'CUSTOMER_DID_NOT_PAY');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customerMmgClaim" "CustomerMmgClaim" NOT NULL DEFAULT 'UNRECORDED',
ADD COLUMN     "customerMmgClaimAt" TIMESTAMP(3),
ADD COLUMN     "mmgClaimResolution" "MmgClaimResolution",
ADD COLUMN     "mmgClaimResolvedAt" TIMESTAMP(3),
ADD COLUMN     "mmgClaimResolvedRevision" INTEGER,
ADD COLUMN     "mmgClaimRevision" INTEGER NOT NULL DEFAULT 0;

-- The generation counter never goes backwards past zero.
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_mmg_claim_revision_nonneg"
  CHECK ("mmgClaimRevision" >= 0);

-- A customer statement is internally consistent with its compatibility
-- projections. UNRECORDED leaves any legacy positive fields alone: they were
-- written before this contract and may have been authored by an operator.
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_customer_mmg_claim_shape"
  CHECK (
    ("customerMmgClaim" = 'UNRECORDED' AND "customerMmgClaimAt" IS NULL)
    OR ("customerMmgClaim" = 'PAID' AND "customerMmgClaimAt" IS NOT NULL AND "customerClaimedPaidAt" IS NOT NULL)
    OR ("customerMmgClaim" = 'NOT_PAID' AND "customerMmgClaimAt" IS NOT NULL
        AND "customerClaimedPaidAt" IS NULL AND "customerPaymentRef" IS NULL)
  );

-- A decision is all-or-nothing and names a generation that has happened.
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_mmg_claim_resolution_shape"
  CHECK (
    ("mmgClaimResolution" IS NULL AND "mmgClaimResolvedAt" IS NULL AND "mmgClaimResolvedRevision" IS NULL)
    OR ("mmgClaimResolution" IS NOT NULL AND "mmgClaimResolvedAt" IS NOT NULL AND "mmgClaimResolvedRevision" IS NOT NULL
        AND "mmgClaimResolvedRevision" >= 1 AND "mmgClaimResolvedRevision" <= "mmgClaimRevision")
  );

-- THE INVARIANT: two claims that disagree are never left unheld.
ALTER TABLE "orders" ADD CONSTRAINT "chk_orders_mmg_disagreement_held"
  CHECK (
    NOT (
      "paymentStatus" IN ('CLAIMED', 'CAPTURED')
      AND "mmgClaimMismatchAt" IS NULL
      AND (
        "customerMmgClaim" = 'NOT_PAID'
        OR ("customerMmgClaim" = 'PAID' AND "customerPaymentRef" IS NOT NULL AND "mmgAttestedRef" IS NOT NULL
            AND "customerPaymentRef" <> "mmgAttestedRef")
      )
      AND NOT ("mmgClaimResolution" IS NOT DISTINCT FROM 'CUSTOMER_PAID'
               AND "mmgClaimResolvedRevision" IS NOT DISTINCT FROM "mmgClaimRevision")
    )
  );
