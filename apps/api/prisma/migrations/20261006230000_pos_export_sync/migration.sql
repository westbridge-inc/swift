-- [POS-SYNC] Re-uploading a till export updates the store.
--
-- FORWARD
--  1. StockMovementReason gains POS_IMPORT: the till's count replaced Swift's after the store confirmed a preview.
--     (Added on its own; nothing in this migration uses the new value.)
--  2. Table "pos_imports" (Prisma-shaped): one row per till export a store confirmed. The id is the upload id the
--     preview handed out; (vendorId, contentHash) is unique, so one file is applied to one store at most once.
--     FK to vendors ON DELETE CASCADE, the tenantId index.
--  3. The tenant wall: RLS ENABLED and FORCED with the canonical policy (rlsDdlFor('pos_imports')).
--  4. Tenant lineage: a row's tenant is its store's tenant (tenantLineageDdl(), byte for byte).
--  5. Frozen: an applied import is a fact. UPDATE is refused; a row leaves only with its store.
--
-- New, empty table; nothing existing is touched or scanned. The enum value is additive.
--
-- ROLLBACK (forward repair is preferred). Roll the application back first. The guard refuses while any applied import
-- exists, because the record of what a store applied would be lost. The enum value stays (Postgres cannot drop one; an
-- unused value is harmless).
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "pos_imports") THEN
--       RAISE EXCEPTION 'refusing rollback: applied till exports exist';
--     END IF;
--   END $$;
--   DROP TABLE "pos_imports";
--   DROP FUNCTION pos_imports_tenant_matches_vendor();
--   DROP FUNCTION pos_imports_frozen();
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261006230000_pos_export_sync';
--   COMMIT;

SET lock_timeout = '10s';

-- 1. The ledger reason.
-- AlterEnum
ALTER TYPE "StockMovementReason" ADD VALUE 'POS_IMPORT';

-- 2. Prisma-shaped objects.
-- CreateTable
CREATE TABLE "pos_imports" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "contentHash" TEXT NOT NULL,
    "planDigest" TEXT NOT NULL,
    "missingPolicy" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_imports_tenantId_idx" ON "pos_imports"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "pos_imports_vendorId_contentHash_key" ON "pos_imports"("vendorId", "contentHash");

-- AddForeignKey
ALTER TABLE "pos_imports" ADD CONSTRAINT "pos_imports_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. The wall, on the row itself (enabled AND forced). Text = rlsDdlFor('pos_imports').
ALTER TABLE "pos_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_imports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pos_imports";
CREATE POLICY "tenant_isolation" ON "pos_imports"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- 4. Lineage held by the database. Text mirrored by tenantLineageDdl() in src/lib/tenant-rls.ts.
CREATE OR REPLACE FUNCTION pos_imports_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM vendors WHERE id = NEW."vendorId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'pos_imports row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'pos_imports row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_imports_tenant_matches_vendor ON pos_imports;
CREATE TRIGGER pos_imports_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON pos_imports FOR EACH ROW EXECUTE FUNCTION pos_imports_tenant_matches_vendor();

-- 5. An applied import is a fact: it is never edited. (DELETE stays possible so a store's rows leave with the store.)
CREATE OR REPLACE FUNCTION pos_imports_frozen() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'pos_imports row % is an applied till export and never changes [POS-SYNC]',
          OLD.id USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_imports_frozen ON pos_imports;
CREATE TRIGGER pos_imports_frozen BEFORE UPDATE ON pos_imports FOR EACH ROW EXECUTE FUNCTION pos_imports_frozen();
