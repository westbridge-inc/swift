-- [M-33] A refund consumes the order's immutable component/line allocation,
-- never a share inferred from the aggregate discount. The redemption snapshot
-- gains the per-line goods allocation and the refund policy it was placed
-- under; a return request records where its discount share came from, the
-- dual-calculation shadow, and the funder. Additive; legacy rows read as
-- "no snapshot" and are routed to review.
SET lock_timeout = '10s';

ALTER TABLE "promo_redemptions" ADD COLUMN "lineAllocations" JSONB;
ALTER TABLE "promo_redemptions" ADD COLUMN "refundPolicy" TEXT NOT NULL DEFAULT 'ALG-25';

ALTER TABLE "return_requests" ADD COLUMN "refundBasis" TEXT;
ALTER TABLE "return_requests" ADD COLUMN "refundInferredAmount" DECIMAL(12,2);
ALTER TABLE "return_requests" ADD COLUMN "refundFunder" TEXT;
