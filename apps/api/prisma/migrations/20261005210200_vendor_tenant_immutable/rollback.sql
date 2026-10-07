-- [row 106 · #1217 · A4] Reverse of 20261005210200: drops only the trigger and
-- its function; no data handling.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TRIGGER IF EXISTS vendors_tenant_immutable ON public.vendors;
DROP FUNCTION IF EXISTS public.vendors_tenant_immutable();
COMMIT;
