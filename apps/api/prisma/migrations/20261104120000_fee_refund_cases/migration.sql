-- [Row 156 · owner 1 Oct 2026] "Weekly-fee refunds: none, except a duplicate or
-- mistaken payment, refunded through MMG within 3 business days."
--
-- The return itself already exists: mmg_fee_reversals. Nothing recorded WHEN a
-- partner asked, so nothing could keep the promise. This table is the ask and
-- its clock. It moves no money, and it can only close on the proof the return
-- already rests on: a case goes to REFUNDED only with a REVERSED reversal of
-- this very payment, and the trigger below holds that, whoever writes the row.
-- A typed number can never close one. Additive: nothing reads this table yet.
SET lock_timeout = '10s';

-- CreateTable
CREATE TABLE "fee_refund_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "openedByUserId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "dueBy" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "reversalId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_refund_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_refund_cases_checkoutId_key" ON "fee_refund_cases"("checkoutId");

-- CreateIndex
CREATE UNIQUE INDEX "fee_refund_cases_reversalId_key" ON "fee_refund_cases"("reversalId");

-- CreateIndex
CREATE INDEX "fee_refund_cases_tenantId_idx" ON "fee_refund_cases"("tenantId");

-- CreateIndex
CREATE INDEX "fee_refund_cases_state_dueBy_idx" ON "fee_refund_cases"("state", "dueBy");

-- AddForeignKey
ALTER TABLE "fee_refund_cases" ADD CONSTRAINT "fee_refund_cases_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "mmg_checkout_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fee_refund_cases"
  ADD CONSTRAINT "fee_refund_cases_kind_check" CHECK ("kind" IN ('DUPLICATE', 'MISTAKEN')),
  ADD CONSTRAINT "fee_refund_cases_state_check" CHECK ("state" IN ('OPEN', 'REFUNDED')),
  ADD CONSTRAINT "fee_refund_cases_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "fee_refund_cases_closed_check"
    CHECK (("state" = 'REFUNDED') = ("reversalId" IS NOT NULL AND "refundedAt" IS NOT NULL));

-- What was asked is written once; a case is born OPEN; it moves OPEN -> REFUNDED
-- and only on a REVERSED reversal of this very payment; REFUNDED is final.
CREATE OR REPLACE FUNCTION fee_refund_cases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' THEN
      RAISE EXCEPTION 'fee_refund_cases: a case is born OPEN [Row 156]' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
     OR NEW."checkoutId" IS DISTINCT FROM OLD."checkoutId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."openedByUserId" IS DISTINCT FROM OLD."openedByUserId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."dueBy" IS DISTINCT FROM OLD."dueBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'fee_refund_cases row %: what was asked is written once [Row 156]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'REFUNDED' AND (NEW."state" IS DISTINCT FROM OLD."state"
       OR NEW."reversalId" IS DISTINCT FROM OLD."reversalId" OR NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt") THEN
    RAISE EXCEPTION 'fee_refund_cases row %: a refunded case is final [Row 156]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'OPEN' AND NEW."state" = 'REFUNDED' AND NOT EXISTS (
       SELECT 1 FROM "mmg_fee_reversals" r
       WHERE r."id" = NEW."reversalId" AND r."checkoutId" = NEW."checkoutId" AND r."state" = 'REVERSED') THEN
    RAISE EXCEPTION 'fee_refund_cases row %: only a REVERSED reversal of this payment closes a case [Row 156]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fee_refund_cases_guard BEFORE INSERT OR UPDATE ON "fee_refund_cases"
  FOR EACH ROW EXECUTE FUNCTION fee_refund_cases_guard();

-- Tenant wall (rlsDdlFor('fee_refund_cases'), src/lib/tenant-rls.ts).
ALTER TABLE "fee_refund_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee_refund_cases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "fee_refund_cases";
CREATE POLICY "tenant_isolation" ON "fee_refund_cases"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
