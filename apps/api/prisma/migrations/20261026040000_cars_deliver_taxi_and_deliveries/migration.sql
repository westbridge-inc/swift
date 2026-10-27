-- [CARS-DELIVER PR4 · owner 8 Oct "car drivers can also take deliveries — switch between them, or get both";
-- COORD ruling 26 Oct: build now, ship after launch, behind CAR_DELIVERIES (OFF)] "Taxi + deliveries".
--
-- drivers."takesDeliveries": while the taxi profile is online and free, its car's delivery profile is also
-- offered store deliveries (only while the CAR_DELIVERIES switch is on). Default false: every existing driver
-- stays taxi rides only, and nothing reads it while the switch is off.
-- riders."returnsToTaxi": this delivery profile went online because a delivery was accepted from taxi work;
-- when its deliveries end the account goes back to taxi work with deliveries on. Default false.
--
-- Two NOT NULL columns with constant defaults: metadata-only on PostgreSQL 11+, no table rewrite, no backfill.
-- Rollback: rollback.sql.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "drivers" ADD COLUMN "takesDeliveries" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "riders" ADD COLUMN "returnsToTaxi" BOOLEAN NOT NULL DEFAULT false;
