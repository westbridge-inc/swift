-- [row 106 · #1217] Reverse of 20261005210000_qr_tenant_lineage: the seven QR
-- lineage triggers and their functions go; every row stays. Runs after the
-- later L05 migrations are rolled back (20261005210200; 20261005210300 is
-- monotonic and stays). Must run as a role that bypasses RLS.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$ BEGIN
  IF to_regprocedure('public.vendors_tenant_immutable()') IS NOT NULL THEN
    RAISE EXCEPTION 'roll back 20261005210200_vendor_tenant_immutable first';
  END IF;
END $$;
DROP TRIGGER IF EXISTS qr_codes_tenant_matches_vendor ON public.qr_codes;
DROP FUNCTION IF EXISTS public.qr_codes_tenant_matches_vendor();
DROP TRIGGER IF EXISTS slug_redirects_tenant_matches_vendor ON public.slug_redirects;
DROP FUNCTION IF EXISTS public.slug_redirects_tenant_matches_vendor();
DROP TRIGGER IF EXISTS pending_attributions_tenant_matches_code ON public.pending_attributions;
DROP FUNCTION IF EXISTS public.pending_attributions_tenant_matches_code();
DROP TRIGGER IF EXISTS attribution_claims_tenant_matches_code ON public.attribution_claims;
DROP FUNCTION IF EXISTS public.attribution_claims_tenant_matches_code();
DROP TRIGGER IF EXISTS scan_events_tenant_matches_code ON public.scan_events;
DROP FUNCTION IF EXISTS public.scan_events_tenant_matches_code();
DROP TRIGGER IF EXISTS scan_daily_rollups_tenant_matches_code ON public.scan_daily_rollups;
DROP FUNCTION IF EXISTS public.scan_daily_rollups_tenant_matches_code();
DROP TRIGGER IF EXISTS orders_tenant_matches_attribution_code ON public.orders;
DROP FUNCTION IF EXISTS public.orders_tenant_matches_attribution_code();
COMMIT;
