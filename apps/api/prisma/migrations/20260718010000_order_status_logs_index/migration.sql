-- SWIFT-AUD-D6-03: order_status_logs.orderId had no index (Prisma doesn't
-- auto-index FKs), so every order-detail / timeline open was a Seq Scan of the
-- whole append-only status log — the table that grows largest in the DB. This
-- composite index serves both the FK filter and the ORDER BY createdAt the
-- statusHistory includes use. Additive; concurrent-safe on a fresh replay.
CREATE INDEX IF NOT EXISTS "order_status_logs_orderId_createdAt_idx" ON "order_status_logs"("orderId", "createdAt");
