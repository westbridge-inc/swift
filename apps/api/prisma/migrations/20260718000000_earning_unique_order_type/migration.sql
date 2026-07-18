-- One earning per (order, type): a mover's fee/fare/tip for an order is a single
-- fact. This unique index makes OrderService.createEarnings idempotent — with
-- createMany({ skipDuplicates: true }) a concurrent second completion of the same
-- order inserts nothing instead of double-paying the mover.
--
-- Additive. On a fresh/clean DB (CI replay from zero, dev, pre-launch) there are
-- no duplicates. If a pre-existing duplicate ever blocked this, it would itself be
-- a prior double-pay to reconcile before applying — surface it, don't drop rows.
CREATE UNIQUE INDEX "earnings_orderId_type_key" ON "earnings"("orderId", "type");
