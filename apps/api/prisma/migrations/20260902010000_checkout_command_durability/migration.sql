-- [M-11] The checkout command's durable tail and result. Additive: two new
-- tables, no existing table or row changes. The outbox carries the queue work
-- an order needs after it commits (written inside the checkout transaction,
-- published by a leased drainer); the receipt carries the one immutable
-- answer per (customer, idempotency key) with the request's fingerprint.
SET lock_timeout = '10s';

CREATE TABLE "order_outbox" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL DEFAULT 'swift-default',
    "dedupeKey"   TEXT NOT NULL,
    "orderId"     TEXT NOT NULL,
    "kind"        TEXT NOT NULL,
    "queue"       TEXT NOT NULL,
    "payload"     JSONB NOT NULL,
    "delayMs"     INTEGER NOT NULL DEFAULT 0,
    "attempts"    INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt"   TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_outbox_dedupeKey_key" ON "order_outbox"("dedupeKey");
CREATE INDEX "order_outbox_processedAt_availableAt_idx" ON "order_outbox"("processedAt", "availableAt");
CREATE INDEX "order_outbox_orderId_idx" ON "order_outbox"("orderId");
CREATE INDEX "order_outbox_tenantId_idx" ON "order_outbox"("tenantId");

CREATE TABLE "checkout_receipts" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL DEFAULT 'swift-default',
    "userId"         TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash"    TEXT NOT NULL,
    "orderIds"       TEXT[],
    "result"         JSONB NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checkout_receipts_userId_idempotencyKey_key" ON "checkout_receipts"("userId", "idempotencyKey");
CREATE INDEX "checkout_receipts_tenantId_idx" ON "checkout_receipts"("tenantId");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "order_outbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "order_outbox";
CREATE POLICY "tenant_isolation" ON "order_outbox"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "checkout_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "checkout_receipts";
CREATE POLICY "tenant_isolation" ON "checkout_receipts"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
