-- [row 106 · #1217 · contract §4.2] READ-ONLY preflight for the L05 QR
-- migrations (20261005210000/210200/210300). Run it before staging and
-- production as a role that bypasses RLS. It prints COUNTS ONLY — no ids, no
-- personal data. Any non-zero count is a HOLD for a person to decide, never a
-- silent repair: the migrations do not restamp or delete legacy rows.
BEGIN READ ONLY;
SET LOCAL row_security = off;
SELECT 'qr_codes whose target store is missing or in another tenant' AS check_name, count(*) AS rows
  FROM public.qr_codes q LEFT JOIN public.vendors v ON v.id = q."entityId" AND q."entityType"::text = 'VENDOR'
 WHERE v.id IS NULL OR v."tenantId" IS DISTINCT FROM q."tenantId"
UNION ALL
SELECT 'slug_redirects whose store is missing or in another tenant', count(*)
  FROM public.slug_redirects r LEFT JOIN public.vendors v ON v.id = r."entityId" AND r."entityType"::text = 'VENDOR'
 WHERE v.id IS NULL OR v."tenantId" IS DISTINCT FROM r."tenantId"
UNION ALL
SELECT 'pending_attributions whose code is missing or in another tenant', count(*)
  FROM public.pending_attributions c LEFT JOIN public.qr_codes q ON q.id = c."qrCodeId"
 WHERE q.id IS NULL OR q."tenantId" IS DISTINCT FROM c."tenantId"
UNION ALL
SELECT 'attribution_claims whose code is missing or in another tenant', count(*)
  FROM public.attribution_claims c LEFT JOIN public.qr_codes q ON q.id = c."qrCodeId"
 WHERE c."qrCodeId" IS NOT NULL AND (q.id IS NULL OR q."tenantId" IS DISTINCT FROM c."tenantId")
UNION ALL
SELECT 'scan_events whose code is missing or in another tenant', count(*)
  FROM public.scan_events c LEFT JOIN public.qr_codes q ON q.id = c."qrCodeId"
 WHERE c."qrCodeId" IS NOT NULL AND (q.id IS NULL OR q."tenantId" IS DISTINCT FROM c."tenantId")
UNION ALL
SELECT 'scan_daily_rollups whose code is missing or in another tenant', count(*)
  FROM public.scan_daily_rollups c LEFT JOIN public.qr_codes q ON q.id = c."qrCodeId"
 WHERE q.id IS NULL OR q."tenantId" IS DISTINCT FROM c."tenantId"
UNION ALL
SELECT 'orders credited to a code of another store or tenant', count(*)
  FROM public.orders o LEFT JOIN public.qr_codes q ON q.id = o."attributionQrCodeId"
 WHERE o."attributionQrCodeId" IS NOT NULL
   AND (q.id IS NULL OR q."tenantId" IS DISTINCT FROM o."tenantId" OR q."entityType"::text <> 'VENDOR' OR q."entityId" IS DISTINCT FROM o."vendorId")
UNION ALL
SELECT 'qr short codes issued twice (reservation conflict)', count(*) FROM (
  SELECT "shortCode" FROM public.qr_codes GROUP BY "shortCode" HAVING count(*) > 1) d
ORDER BY 1;
ROLLBACK;
