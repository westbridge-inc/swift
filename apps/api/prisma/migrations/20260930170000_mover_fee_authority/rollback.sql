-- Schema rollback is safe only before any payer has adopted an authority.
-- Once populated, hold/member facts must remain available for finance and
-- collection fencing. Use a forward repair; do not discard those decisions.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mover_fee_authorities)
    OR EXISTS (SELECT 1 FROM mover_fee_subscriptions) THEN
    RAISE EXCEPTION 'mover fee rollback requires empty authority tables; preserve live decisions with a forward repair';
  END IF;
END $$;
DROP TRIGGER mover_fee_source_owner ON subscriptions;
DROP TRIGGER mover_fee_rider_owner ON riders;
DROP TRIGGER mover_fee_driver_owner ON drivers;
DROP TABLE mover_fee_subscriptions;
DROP TABLE mover_fee_authorities;
DROP FUNCTION mover_fee_preserve_source_owner();
DROP FUNCTION mover_fee_validate_authority();
DROP FUNCTION mover_fee_preserve_authority();
DROP INDEX "users_id_tenantId_key";
DROP TYPE "MoverFeeAuthorityState";
COMMIT;
