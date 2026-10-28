-- [IN-STORE-SALE] A store with no till system takes an item it sold in person off its Swift stock in one tap.
--
-- FORWARD: one new value in each stock reason enum. No table, column or existing row changes; every
-- existing reason keeps its meaning, and the stock adjust route still accepts exactly the five it did.
--
-- ROLLBACK (honest scope). PostgreSQL cannot drop a value from an enum without rebuilding the type, so a
-- rollback leaves 'IN_STORE_SALE' in both types (inert while no row uses it). PRECONDITION for running the
-- previous application: no stock_movements or stock_adjustments row may carry it, because the previous
-- Prisma client cannot read it. stock_movements is append-only, so in practice: roll forward, not back.
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'IN_STORE_SALE';
ALTER TYPE "StockAdjustmentReason" ADD VALUE IF NOT EXISTS 'IN_STORE_SALE';
