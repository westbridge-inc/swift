-- Inventory engine (master plan §4.2): tracked stock decrements at checkout,
-- auto-hides at zero, alerts the owner at the low-stock threshold, and
-- restocks on pre-pickup cancellation.
ALTER TABLE "items" ADD COLUMN     "lowStockThreshold" INTEGER;
ALTER TABLE "items" ADD COLUMN     "autoHiddenAt" TIMESTAMP(3);

-- New notification channel for stock alerts.
ALTER TYPE "NotificationType" ADD VALUE 'LOW_STOCK';
