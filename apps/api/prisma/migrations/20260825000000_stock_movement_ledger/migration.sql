-- MKT-2 Movement 1 — THE STOCK LEDGER.
--
-- Item.stockQuantity becomes a cache; stock_movements becomes the truth.
-- Expand-only: nothing is dropped, no existing column changes meaning, and the
-- counter keeps working exactly as it does today.
SET lock_timeout = '10s';

CREATE TYPE "StockMovementReason" AS ENUM (
  'SALE',
  'CANCEL_RESTOCK',
  'PICK',
  'PICK_REFUND',
  'RECEIVED',
  'DAMAGED',
  'MANUAL',
  'RECONCILE',
  'RETURN',
  'OPENING_BALANCE'
);

CREATE TABLE "stock_movements" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL DEFAULT 'swift-default',
  "itemId"       TEXT NOT NULL,
  "delta"        INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "reason"       "StockMovementReason" NOT NULL,
  -- orderId is deliberately NOT a foreign key: deleting an order must never
  -- cascade away the inventory evidence that it happened.
  "orderId"      TEXT,
  "actorId"      TEXT,
  "note"         TEXT,
  "occurredAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- itemId is deliberately NOT a foreign key, for the same reason orderId is not.
-- A cascading delete would erase inventory evidence the moment an item row went
-- away, and the append-only trigger below would refuse the cascade anyway — so
-- the two guarantees would fight and item deletion would simply fail. History
-- outlives the row it describes.

CREATE INDEX "stock_movements_itemId_occurredAt_idx"   ON "stock_movements"("itemId", "occurredAt");
CREATE INDEX "stock_movements_tenantId_occurredAt_idx" ON "stock_movements"("tenantId", "occurredAt");
CREATE INDEX "stock_movements_orderId_idx"             ON "stock_movements"("orderId");

-- THE OPENING BALANCE.
-- Every tracked item gets one movement carrying the stock it already had, so
-- the ledger explains the counter it inherited rather than pretending inventory
-- history began the day this shipped. Without this, every pre-existing item
-- would look like it drifted by exactly its current quantity.
INSERT INTO "stock_movements" ("id", "tenantId", "itemId", "delta", "balanceAfter", "reason", "note", "occurredAt")
SELECT
  'sm_open_' || i."id",
  COALESCE(v."tenantId", 'swift-default'),
  i."id",
  i."stockQuantity",
  i."stockQuantity",
  'OPENING_BALANCE',
  'Stock on hand when the ledger was introduced',
  CURRENT_TIMESTAMP
FROM "items" i
JOIN "vendors" v ON v."id" = i."vendorId"
WHERE i."stockQuantity" IS NOT NULL;

-- APPEND-ONLY, ENFORCED IN THE DATABASE.
-- A stock ledger that can be rewritten is not evidence. Corrections are new
-- compensating rows (RECONCILE), never edits — so UPDATE and DELETE are refused
-- outright, and TRUNCATE is revoked and trapped. Same shape the moderation
-- tables use: the one moment someone wants to erase this is the moment it
-- matters most.
CREATE OR REPLACE FUNCTION "stock_movements_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only: record a compensating movement instead of altering history';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_movements_no_update"
  BEFORE UPDATE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_append_only"();

CREATE TRIGGER "stock_movements_no_delete"
  BEFORE DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_append_only"();

REVOKE TRUNCATE ON "stock_movements" FROM PUBLIC;

CREATE TRIGGER "stock_movements_no_truncate"
  BEFORE TRUNCATE ON "stock_movements"
  EXECUTE FUNCTION "stock_movements_append_only"();

-- Tenancy, same as every other table.
-- [W-201 / F-021-11] Tenant isolation, the CANONICAL predicate — the same DDL
-- `rlsDdlFor()` in src/lib/tenant-rls.ts emits, and the census test asserts.
--
-- This block was rewritten before merge. As first written it used
-- `current_setting('app.tenant_id')` with `OR ... IS NULL` as the bypass, which
-- is the RETIRED shape: a session that simply never sets the GUC sees every
-- operator's inventory. The bypass is a ROLE, never a value a session can set
-- on itself. It also FORCEd RLS immediately, outside the staged
-- expand -> verify -> contract rollout the other tenant tables follow.
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_movements";
CREATE POLICY "tenant_isolation" ON "stock_movements"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
