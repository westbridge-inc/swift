-- Only an unused checkout expansion may be rolled back. A checkout, the keys
-- it answered and every reply and lookup written down for it are payment
-- evidence: a payment may be confirming, held or credited against them. After
-- any use, keep the schema and repair forward. The confirmation holds of
-- 20260930180000_shared_billing_confirmation_clock reference these checkouts,
-- so that migration is rolled back first.
-- The tables force row-level security, so a role that sees only some rows
-- could find them "empty". Row security is switched off for this transaction:
-- a role that does not bypass it is refused with an error instead. Run this
-- as a role that bypasses row-level security (a superuser or BYPASSRLS).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
DO $$ BEGIN
  IF to_regclass('public.payment_confirmation_holds') IS NOT NULL THEN
    RAISE EXCEPTION 'mmg checkout rollback requires 20260930180000_shared_billing_confirmation_clock to be rolled back first';
  END IF;
END $$;
LOCK TABLE mmg_checkout_observations, mmg_checkout_keys, mmg_checkout_intents IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mmg_checkout_intents)
    OR EXISTS (SELECT 1 FROM mmg_checkout_keys)
    OR EXISTS (SELECT 1 FROM mmg_checkout_observations) THEN
    RAISE EXCEPTION 'mmg checkout rollback requires empty checkout tables; preserve payment evidence with a forward repair';
  END IF;
END $$;
DROP TABLE mmg_checkout_observations;
DROP TABLE mmg_checkout_keys;
DROP TABLE mmg_checkout_intents;
COMMIT;
