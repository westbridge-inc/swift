-- [M-32] Promo terms are versioned and immutable; a redemption snapshots the
-- terms version, the funder and the discount per component; and the database
-- carries the bounds itself (percentage 0..100, non-negative money, a real
-- window, usage counts of at least one). Invalid ACTIVE promos are frozen
-- first (the operations clause); the checks are added NOT VALID so a legacy
-- row that is already invalid stays readable but can never be re-saved
-- invalid. Additive.
SET lock_timeout = '10s';

CREATE TYPE "PromoFunder" AS ENUM ('PLATFORM', 'VENDOR');

ALTER TABLE "promo_codes" ADD COLUMN "funder" "PromoFunder" NOT NULL DEFAULT 'PLATFORM';
ALTER TABLE "promo_codes" ADD COLUMN "termsVersion" INTEGER NOT NULL DEFAULT 1;
UPDATE "promo_codes" SET "funder" = 'VENDOR' WHERE "vendorId" IS NOT NULL;

CREATE TABLE "promo_terms" (
  "id" TEXT NOT NULL,
  "promoCodeId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "discountType" "DiscountType" NOT NULL,
  "discountValue" DECIMAL(10,2) NOT NULL,
  "minOrderAmount" DECIMAL(10,2),
  "maxDiscount" DECIMAL(10,2),
  "applicableTo" "OrderType"[],
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validUntil" TIMESTAMP(3) NOT NULL,
  "maxUses" INTEGER,
  "maxUsesPerUser" INTEGER NOT NULL,
  "funder" "PromoFunder" NOT NULL,
  "restoredFrom" INTEGER,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_terms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "promo_terms_promoCodeId_version_key" ON "promo_terms"("promoCodeId", "version");
ALTER TABLE "promo_terms" ADD CONSTRAINT "promo_terms_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "promo_redemptions" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "promoCodeId" TEXT NOT NULL,
  "termsVersion" INTEGER NOT NULL,
  "discountType" "DiscountType" NOT NULL,
  "discountValue" DECIMAL(10,2) NOT NULL,
  "maxDiscount" DECIMAL(10,2),
  "funder" "PromoFunder" NOT NULL,
  "goodsDiscount" DECIMAL(12,2) NOT NULL,
  "deliveryDiscount" DECIMAL(12,2) NOT NULL,
  "tipDiscount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "promo_redemptions_orderId_key" ON "promo_redemptions"("orderId");
CREATE INDEX "promo_redemptions_promoCodeId_idx" ON "promo_redemptions"("promoCodeId");
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- No component below zero, and the tip is never discounted: no sponsor rail exists to fund it.
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_components_check"
  CHECK ("goodsDiscount" >= 0 AND "deliveryDiscount" >= 0 AND "tipDiscount" = 0);

-- Freeze invalid ACTIVE promos before the law lands.
UPDATE "promo_codes" SET "isActive" = false
WHERE "isActive" = true AND (
  ("discountType" = 'PERCENTAGE' AND "discountValue" > 100) OR "discountValue" < 0
  OR "validFrom" >= "validUntil"
  OR ("maxDiscount" IS NOT NULL AND "maxDiscount" < 0) OR ("minOrderAmount" IS NOT NULL AND "minOrderAmount" < 0)
  OR ("maxUses" IS NOT NULL AND "maxUses" < 1) OR "maxUsesPerUser" < 1);

ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_percentage_check"
  CHECK ("discountType" <> 'PERCENTAGE' OR "discountValue" <= 100) NOT VALID;
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_money_nonnegative_check"
  CHECK ("discountValue" >= 0 AND ("maxDiscount" IS NULL OR "maxDiscount" >= 0) AND ("minOrderAmount" IS NULL OR "minOrderAmount" >= 0)) NOT VALID;
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_window_check"
  CHECK ("validFrom" < "validUntil") NOT VALID;
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_uses_check"
  CHECK (("maxUses" IS NULL OR "maxUses" >= 1) AND "maxUsesPerUser" >= 1) NOT VALID;

-- Version 1 for every existing promo: its terms as they stand today.
INSERT INTO "promo_terms" ("id", "promoCodeId", "version", "discountType", "discountValue", "minOrderAmount", "maxDiscount", "applicableTo", "validFrom", "validUntil", "maxUses", "maxUsesPerUser", "funder", "createdBy")
SELECT gen_random_uuid()::text, "id", "termsVersion", "discountType", "discountValue", "minOrderAmount", "maxDiscount", "applicableTo", "validFrom", "validUntil", "maxUses", "maxUsesPerUser", "funder", 'migration:M-32'
FROM "promo_codes";
