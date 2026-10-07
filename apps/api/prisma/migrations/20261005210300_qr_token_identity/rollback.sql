-- [row 106 · #1217 · contract §4.2] MONOTONIC: printed-token identity is
-- permanent. Rolling the application back does NOT remove the registry, its
-- reservations or the seven identity triggers; this is not a restoration of
-- the old schema. This file only asserts they are all still present.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$
DECLARE missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regnamespace('swift_qr') IS NULL THEN missing := missing || 'schema swift_qr'::text; END IF;
  IF to_regclass('swift_qr.token_identities') IS NULL THEN missing := missing || 'swift_qr.token_identities'::text; END IF;
  SELECT missing || ARRAY(
    SELECT n FROM unnest(ARRAY['qr_codes_token_reserve', 'qr_codes_token_retire', 'qr_codes_identity_immutable',
                               'vendors_qr_target_identity', 'vendors_qr_target_retire',
                               'token_identities_immutable', 'token_identities_no_truncate']) AS n
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = n AND NOT tgisinternal))
  INTO missing;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'QR_TOKEN_IDENTITY_MISSING: %', array_to_string(missing, ', ');
  END IF;
END $$;
COMMIT;
