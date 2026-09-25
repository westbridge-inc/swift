-- [E02 · refund rail 1/8] THE MMG REFUND RAIL: the foundation. Inert.
--
-- A store paid by MMG holds the customer's money in its own wallet; Swift never
-- does (spec §3.1:5250). Until now every money change on a paid MMG order failed
-- closed (picking.service assertMmgMoneyAdjustable, the cancel seam's
-- MMG_CANCEL_UNAVAILABLE) because nothing could record what the store then owes
-- back. The owner decided the rail on 09-24: the store refunds from its own MMG
-- and taps "Refund sent" with the MMG reference, the customer confirms or says no
-- (a support ticket), the deadline is 72 h, the MMG checkout turns off after 2
-- missed deadlines, and Swift pays the MMG fee.
-- Plan: ~/swift-coordination/MMG-REFUND-RAIL-PLAN-20260924.md.
--
-- This migration lays the ground. Nothing writes the new tables yet:
--   - "orders"."mmgAttestedAmount": what the store attested it received, THE
--     CAP. recordVendorAttestation writes it from this release on (the one live
--     change); existing CLAIMED/CAPTURED MMG orders are backfilled below.
--   - "mmg_refund_obligations" and "mmg_refund_sends", with their four enums.
--   - "vendors": the MMG checkout hold (when, why, who) and the mark misses are
--     counted from. Misses are counted from the obligations, never stored.
--   - CHECKs: positive amounts, a non-negative fee, and "sendId" set exactly
--     while an obligation is SENT, CONFIRMED, DISPUTED or SETTLED.
--   - Two DEFERRED constraint triggers, checked at COMMIT so the writes of one
--     transaction may land in any order:
--       * the cap: the non-void obligations of an order never add up to more
--         than its "mmgAttestedAmount"; with nothing attested, none may stand;
--       * the paid-cancel guard (§3.1:5252): an MMG order the store claimed
--         (CLAIMED) or a provider captured (CAPTURED) never becomes CANCELLED
--         or REFUNDED without a CANCELLATION obligation committed with it.
--         Existing rows are not re-judged: only a change of status is checked.
--   - The tenant wall on both tables (RLS enabled and forced, text from
--     rlsDdlFor()) and the lineage rule (a row's tenant is its order's, text
--     from tenantLineageDdl()), both in src/lib/tenant-rls.ts.
--
-- No application path moves a paid MMG order to CANCELLED or REFUNDED today:
-- customer cancel, vendor reject, admin cancel and the no-response auto-cancel
-- all refuse it (MMG_CANCEL_UNAVAILABLE), the food-age cutoff holds it for a
-- person instead, and refund-settled needs an A-14 obligation no MMG order can
-- carry. The guard changes no behaviour; it makes the refusal the database's.
--
-- BACKFILL: each CLAIMED/CAPTURED MMG order takes the amount named by its latest
-- ATTEST_MMG_PAYMENT audit row (the attestation records String(totalAmount)
-- there), else its "totalAmount": the same figure, because an MMG total cannot
-- change in-app. It runs before the triggers exist, so it queues no trigger
-- events. Like the earlier backfills (20260905160000), it assumes the migrating
-- role sees every order (a superuser, or a member of swift_bypass_rls): under
-- FORCE row security any other role would silently update nothing.
--
-- ROLLBACK (roll the application back first; forward repair is preferred). It
-- refuses while refund evidence exists, and the ATTEST_MMG_PAYMENT audit rows
-- keep every attested amount the dropped column held:
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "mmg_refund_obligations") OR EXISTS (SELECT 1 FROM "mmg_refund_sends")
--        OR EXISTS (SELECT 1 FROM "vendors" WHERE "mmgCheckoutHeldAt" IS NOT NULL OR "mmgMissesClearedAt" IS NOT NULL) THEN
--       RAISE EXCEPTION 'refusing rollback: MMG refund evidence or an MMG checkout hold would be discarded';
--     END IF;
--   END $$;
--   DROP TRIGGER "orders_paid_mmg_terminal_needs_refund_obligation" ON "orders";
--   DROP TRIGGER "orders_mmg_attested_holds_refund_obligations" ON "orders";
--   DROP TABLE "mmg_refund_obligations";
--   DROP TABLE "mmg_refund_sends";
--   DROP FUNCTION orders_paid_mmg_terminal_needs_refund_obligation();
--   DROP FUNCTION mmg_refund_obligations_within_attested();
--   DROP FUNCTION mmg_refund_obligations_tenant_matches_order();
--   DROP FUNCTION mmg_refund_sends_tenant_matches_order();
--   DROP TYPE "MmgRefundResolution";
--   DROP TYPE "MmgRefundAnswer";
--   DROP TYPE "MmgRefundStatus";
--   DROP TYPE "MmgRefundKind";
--   ALTER TABLE "vendors" DROP COLUMN "mmgCheckoutHeldAt", DROP COLUMN "mmgCheckoutHeldReason",
--     DROP COLUMN "mmgCheckoutHeldById", DROP COLUMN "mmgMissesClearedAt";
--   ALTER TABLE "orders" DROP COLUMN "mmgAttestedAmount";
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925000100_mmg_refund_rail';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;
SET lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "MmgRefundKind" AS ENUM ('CANCELLATION', 'LINE_REMOVED', 'SUBSTITUTE_REJECTED', 'SUBSTITUTE_CHEAPER');

-- CreateEnum
CREATE TYPE "MmgRefundStatus" AS ENUM ('OWED', 'SENT', 'CONFIRMED', 'DISPUTED', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MmgRefundAnswer" AS ENUM ('RECEIVED', 'NOT_RECEIVED');

-- CreateEnum
CREATE TYPE "MmgRefundResolution" AS ENUM ('RECEIVED', 'NOT_RECEIVED');

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "mmgCheckoutHeldAt" TIMESTAMP(3),
ADD COLUMN     "mmgCheckoutHeldById" TEXT,
ADD COLUMN     "mmgCheckoutHeldReason" TEXT,
ADD COLUMN     "mmgMissesClearedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "mmgAttestedAmount" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "mmg_refund_obligations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "kind" "MmgRefundKind" NOT NULL,
    "causeKey" TEXT NOT NULL,
    "status" "MmgRefundStatus" NOT NULL DEFAULT 'OWED',
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'GYD',
    "basis" TEXT NOT NULL,
    "reason" TEXT,
    "deadlineHours" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "missedAt" TIMESTAMP(3),
    "sendId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdById" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mmg_refund_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mmg_refund_sends" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "orderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mmgRefundRef" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "feeBorneBySwift" DECIMAL(12,2),
    "currencyCode" TEXT NOT NULL DEFAULT 'GYD',
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answer" "MmgRefundAnswer",
    "answeredAt" TIMESTAMP(3),
    "supportTicketId" TEXT,
    "resolution" "MmgRefundResolution",
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "coveredObligationIds" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mmg_refund_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mmg_refund_obligations_causeKey_key" ON "mmg_refund_obligations"("causeKey");

-- CreateIndex
CREATE INDEX "mmg_refund_obligations_vendorId_status_idx" ON "mmg_refund_obligations"("vendorId", "status");

-- CreateIndex
CREATE INDEX "mmg_refund_obligations_customerId_status_idx" ON "mmg_refund_obligations"("customerId", "status");

-- CreateIndex
CREATE INDEX "mmg_refund_obligations_status_dueAt_idx" ON "mmg_refund_obligations"("status", "dueAt");

-- CreateIndex
CREATE INDEX "mmg_refund_obligations_vendorId_missedAt_idx" ON "mmg_refund_obligations"("vendorId", "missedAt");

-- CreateIndex
CREATE INDEX "mmg_refund_obligations_orderId_idx" ON "mmg_refund_obligations"("orderId");

-- CreateIndex
CREATE INDEX "mmg_refund_obligations_tenantId_idx" ON "mmg_refund_obligations"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "mmg_refund_sends_mmgRefundRef_key" ON "mmg_refund_sends"("mmgRefundRef");

-- CreateIndex
CREATE INDEX "mmg_refund_sends_orderId_idx" ON "mmg_refund_sends"("orderId");

-- CreateIndex
CREATE INDEX "mmg_refund_sends_customerId_answer_idx" ON "mmg_refund_sends"("customerId", "answer");

-- CreateIndex
CREATE INDEX "mmg_refund_sends_vendorId_sentAt_idx" ON "mmg_refund_sends"("vendorId", "sentAt");

-- CreateIndex
CREATE INDEX "mmg_refund_sends_tenantId_idx" ON "mmg_refund_sends"("tenantId");

-- AddForeignKey
ALTER TABLE "mmg_refund_obligations" ADD CONSTRAINT "mmg_refund_obligations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mmg_refund_obligations" ADD CONSTRAINT "mmg_refund_obligations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mmg_refund_obligations" ADD CONSTRAINT "mmg_refund_obligations_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "mmg_refund_sends"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mmg_refund_sends" ADD CONSTRAINT "mmg_refund_sends_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mmg_refund_sends" ADD CONSTRAINT "mmg_refund_sends_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Raw money laws (below this line: everything `prisma migrate diff` can't say)
-- ============================================================================

-- A refund owed or sent is money, so it is never zero or negative.
ALTER TABLE "mmg_refund_obligations" ADD CONSTRAINT "chk_mmg_refund_obligations_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "mmg_refund_sends" ADD CONSTRAINT "chk_mmg_refund_sends_amount_positive"
  CHECK ("amount" > 0);

-- The MMG fee Swift pays back is recorded as it was, never negative.
ALTER TABLE "mmg_refund_sends" ADD CONSTRAINT "chk_mmg_refund_sends_fee_nonneg"
  CHECK ("feeBorneBySwift" IS NULL OR "feeBorneBySwift" >= 0);

-- An obligation names its send exactly while a send covers it. The law in
-- order/mmg-refund-law.ts (STATUS_LAW.carriesSend) mirrors this list.
ALTER TABLE "mmg_refund_obligations" ADD CONSTRAINT "chk_mmg_refund_obligations_send_shape"
  CHECK (("sendId" IS NOT NULL) = ("status" IN ('SENT', 'CONFIRMED', 'DISPUTED', 'SETTLED')));

-- BACKFILL (see the header): the cap every existing paid MMG order already has.
-- It REQUIRES a role that bypasses row security: a superuser, a BYPASSRLS role,
-- or a member of swift_bypass_rls. "orders" is FORCE ROW LEVEL SECURITY, and a
-- migration binds no app.current_tenant, so under any other role the policy
-- hides every row and this UPDATE silently changes nothing. Every environment
-- migrates as the database superuser today (DS272 F3).
WITH attested AS (
  SELECT DISTINCT ON (a."entityId") a."entityId" AS "orderId", a."changes"->>'amount' AS "amount"
    FROM "audit_logs" a
   WHERE a."entity" = 'Order' AND a."action" = 'ATTEST_MMG_PAYMENT'
   ORDER BY a."entityId", a."createdAt" DESC, a."id" DESC
)
UPDATE "orders" o
   SET "mmgAttestedAmount" = COALESCE(
         (SELECT CASE WHEN t."amount" ~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' THEN t."amount"::numeric(12,2) END
            FROM attested t
           WHERE t."orderId" = o."id"),
         o."totalAmount")
 WHERE o."paymentMethod" = 'MOBILE_MONEY'
   AND o."paymentStatus" IN ('CLAIMED', 'CAPTURED')
   AND o."mmgAttestedAmount" IS NULL;

-- THE CAP. The non-void obligations of an order never add up to more than what
-- the store attested it received; with nothing attested, no obligation stands.
-- Checked at COMMIT, from both sides: an obligation written or moved, and an
-- attested amount changed. The order row is locked before the sum is read, so
-- two transactions adding obligations to one order are judged one after the
-- other, each against a sum that includes the other's committed rows. An order
-- this session cannot see while it owes something fails closed.
CREATE OR REPLACE FUNCTION mmg_refund_obligations_within_attested() RETURNS trigger AS $$
DECLARE
  order_id TEXT;
  order_seen BOOLEAN;
  attested NUMERIC;
  owed NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    order_id := NEW."id";
  ELSE
    order_id := NEW."orderId";
  END IF;
  SELECT o."mmgAttestedAmount" INTO attested FROM "orders" o WHERE o."id" = order_id FOR NO KEY UPDATE;
  order_seen := FOUND;
  SELECT COALESCE(SUM(r."amount"), 0) INTO owed
    FROM "mmg_refund_obligations" r
   WHERE r."orderId" = order_id AND r."status" <> 'VOIDED';
  IF owed = 0 THEN
    RETURN NULL;
  END IF;
  IF NOT order_seen OR attested IS NULL OR owed > attested THEN
    RAISE EXCEPTION 'MMG_REFUND_OVER_ATTESTED: order % would owe % back by MMG, but the store attested % [E02]',
      order_id, owed, COALESCE(attested::text, 'nothing') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "mmg_refund_obligations_within_attested"
  AFTER INSERT OR UPDATE OF "amount", "status", "orderId" ON "mmg_refund_obligations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mmg_refund_obligations_within_attested();

CREATE CONSTRAINT TRIGGER "orders_mmg_attested_holds_refund_obligations"
  AFTER UPDATE OF "mmgAttestedAmount" ON "orders"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."mmgAttestedAmount" IS DISTINCT FROM NEW."mmgAttestedAmount")
  EXECUTE FUNCTION mmg_refund_obligations_within_attested();

-- THE PAID-CANCEL GUARD (§3.1:5252). An MMG order is paid once the store claimed
-- it (CLAIMED) or a provider captured it (CAPTURED): the predicate of
-- MMG_MONEY_MOVED in order/order.service.ts, word for word. Such an order may
-- become CANCELLED or REFUNDED only when a CANCELLATION obligation that is not
-- VOIDED is committed with it. Paid before the change or after it, both count:
-- one statement cannot cancel a paid order by rewriting its payment state in
-- the same breath. The WHEN clause means only such a status change is ever
-- judged; every existing row, and every other update, is left alone.
CREATE OR REPLACE FUNCTION orders_paid_mmg_terminal_needs_refund_obligation() RETURNS trigger AS $$
BEGIN
  -- An order deleted later in the same transaction has no status left to hold.
  IF NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."id" = NEW."id") THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "mmg_refund_obligations" r
     WHERE r."orderId" = NEW."id" AND r."kind" = 'CANCELLATION' AND r."status" <> 'VOIDED'
  ) THEN
    RAISE EXCEPTION 'MMG_REFUND_OBLIGATION_REQUIRED: order % is paid by MMG and cannot become % without a CANCELLATION refund obligation [E02 · spec 3.1]',
      NEW."id", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "orders_paid_mmg_terminal_needs_refund_obligation"
  AFTER UPDATE OF "status" ON "orders"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    NEW."status" IN ('CANCELLED', 'REFUNDED')
    AND OLD."status" IS DISTINCT FROM NEW."status"
    AND (
      (OLD."paymentMethod" = 'MOBILE_MONEY' AND OLD."paymentStatus" IN ('CLAIMED', 'CAPTURED'))
      OR (NEW."paymentMethod" = 'MOBILE_MONEY' AND NEW."paymentStatus" IN ('CLAIMED', 'CAPTURED'))
    )
  )
  EXECUTE FUNCTION orders_paid_mmg_terminal_needs_refund_obligation();

-- The wall, on the row itself (enabled AND forced), and the lineage held by the
-- database. Text generated from src/lib/tenant-rls.ts (rlsDdlFor, tenantLineageDdl).
ALTER TABLE "mmg_refund_obligations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_refund_obligations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_refund_obligations";
CREATE POLICY "tenant_isolation" ON "mmg_refund_obligations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "mmg_refund_sends" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_refund_sends" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_refund_sends";
CREATE POLICY "tenant_isolation" ON "mmg_refund_sends"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION mmg_refund_obligations_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'mmg_refund_obligations row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'mmg_refund_obligations row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mmg_refund_obligations_tenant_matches_order ON mmg_refund_obligations;
CREATE TRIGGER mmg_refund_obligations_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON mmg_refund_obligations FOR EACH ROW EXECUTE FUNCTION mmg_refund_obligations_tenant_matches_order();
CREATE OR REPLACE FUNCTION mmg_refund_sends_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM orders WHERE id = NEW."orderId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'mmg_refund_sends row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'mmg_refund_sends row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mmg_refund_sends_tenant_matches_order ON mmg_refund_sends;
CREATE TRIGGER mmg_refund_sends_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId" ON mmg_refund_sends FOR EACH ROW EXECUTE FUNCTION mmg_refund_sends_tenant_matches_order();
