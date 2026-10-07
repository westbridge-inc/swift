-- [row 106 · #1217 · coordinator contract A1] A store's tenant never changes.
-- No path in the application moves a vendor between operators, and a move
-- would leave its printed QR codes, credit receipts and every other child
-- in the old tenant. Instead of a move guard, the move itself is refused for
-- every role (request login, system login and owner alike), so an old-tenant
-- child write can never meet a moved parent. A future need to move a store is
-- its own reviewed change.
BEGIN;
CREATE OR REPLACE FUNCTION public.vendors_tenant_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'VENDOR_TENANT_IMMUTABLE: vendor % cannot change tenant', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vendors_tenant_immutable ON public.vendors;
CREATE TRIGGER vendors_tenant_immutable BEFORE UPDATE OF "tenantId" ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.vendors_tenant_immutable();
COMMIT;
