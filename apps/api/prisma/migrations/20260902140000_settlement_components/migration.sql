-- [M-38] The vendor's weekly record separates goods sales, the vendor's own
-- promotions, the platform-funded discount owed to the vendor (sponsor
-- receivable), what customers actually paid for goods, platform fee funding,
-- and the mover's payable — from each order's redemption snapshot. Rows
-- written before this carry NULL components (componentsVersion 0): estimated,
-- not settled, until recomputed as an immutable ADJUSTMENT. Additive.
SET lock_timeout = '10s';
ALTER TABLE "settlements" ADD COLUMN "goodsSales" DECIMAL(12,2);
ALTER TABLE "settlements" ADD COLUMN "vendorPromoDiscount" DECIMAL(12,2);
ALTER TABLE "settlements" ADD COLUMN "sponsorReceivable" DECIMAL(12,2);
ALTER TABLE "settlements" ADD COLUMN "customerCollection" DECIMAL(12,2);
ALTER TABLE "settlements" ADD COLUMN "feeFunding" DECIMAL(12,2);
ALTER TABLE "settlements" ADD COLUMN "moverPayable" DECIMAL(12,2);
ALTER TABLE "settlements" ADD COLUMN "estimatedOrders" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "settlements" ADD COLUMN "componentsVersion" INTEGER NOT NULL DEFAULT 0;
-- The columns reconcile with each other when present.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_components_reconcile_check"
  CHECK ("goodsSales" IS NULL OR ("customerCollection" = "goodsSales" - "vendorPromoDiscount" - "sponsorReceivable" AND "netSales" = "goodsSales" - "vendorPromoDiscount"));
