-- Rollback: the indexes hold no data, so they can always be dropped; search
-- keeps working (it falls back to reading every row, as before).
-- The extension is dropped only when nothing else uses it.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS "items_name_trgm_idx";
DROP INDEX IF EXISTS "items_description_trgm_idx";
DROP INDEX IF EXISTS "vendors_name_trgm_idx";
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
    WHERE e.extname = 'pg_trgm' AND d.deptype = 'n'
  ) THEN
    DROP EXTENSION IF EXISTS pg_trgm;
  END IF;
END
$guard$;
COMMIT;
