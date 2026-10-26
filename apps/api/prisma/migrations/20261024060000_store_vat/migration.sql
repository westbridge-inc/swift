-- [STORE-VAT · owner O-5, 22 Oct 2026] A store's VAT, set by the store, shown only after a PERSON approved its
-- GRA VAT registration certificate (VAT Act Cap. 81:05; sources in modules/store-vat/vat-rate.ts).
--
-- ADDITIVE ONLY: three new enum types and nullable / defaulted columns. Every existing store reads NONE
-- (not VAT-registered), every existing item STANDARD (which carries no VAT until its store is approved),
-- and every existing order NULL VAT (placed before VAT existed). No price, total or money path changes.
-- Not platform config: no re-seed.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

CREATE TYPE "VatClass" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');
CREATE TYPE "StoreVatStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED');
CREATE TYPE "StoreVatMode" AS ENUM ('PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT');

ALTER TABLE "vendors"
  ADD COLUMN "vatStatus" "StoreVatStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "vatMode" "StoreVatMode",
  ADD COLUMN "vatCertificateDocId" TEXT,
  ADD COLUMN "vatApprovedNumber" TEXT,
  ADD COLUMN "vatApprovedName" TEXT,
  ADD COLUMN "vatEffectiveFrom" DATE,
  ADD COLUMN "vatReviewedBy" TEXT,
  ADD COLUMN "vatReviewedAt" TIMESTAMP(3),
  ADD COLUMN "vatReviewNote" TEXT;

ALTER TABLE "items" ADD COLUMN "vatClass" "VatClass" NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "orders"
  ADD COLUMN "vatAmount" DECIMAL(12,2),
  ADD COLUMN "vatRateBps" INTEGER,
  ADD COLUMN "vatStandardGoods" DECIMAL(12,2),
  ADD COLUMN "vatZeroRatedGoods" DECIMAL(12,2),
  ADD COLUMN "vatExemptGoods" DECIMAL(12,2),
  ADD COLUMN "vatBase" DECIMAL(12,2),
  ADD COLUMN "vatSellerNumber" TEXT,
  ADD COLUMN "vatSellerName" TEXT;

ALTER TABLE "order_items" ADD COLUMN "vatClass" "VatClass";
