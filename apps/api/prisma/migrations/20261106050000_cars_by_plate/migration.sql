-- [CARS-PLATES · owner 6 Nov 2026 ~04:20Z: P-plate (private) cars deliver only; H-plate (hire) cars drive taxi
-- rides and deliver] The columns the earlier, never-merged CARS-DELIVER work (#2138) added, re-stamped above
-- main's newest migration. Plate class itself is NOT stored: it is the plate's first letter, read from the
-- registration a person approved (verification/subjects plateClassOf; schema VehicleProfile: "never a second copy").
--
-- drivers."takesDeliveries": while the taxi profile is online and free, its car's delivery profile is also
-- offered store deliveries (only while the CAR_DELIVERIES switch is on). Default false: every existing driver
-- stays taxi rides only.
-- riders."returnsToTaxi": this delivery profile went online because a delivery was accepted from taxi work;
-- when its deliveries end the account goes back to taxi work with deliveries on. Default false.
-- drivers."deliveryCardsCapable": the app on this taxi's last GO declared CAR_DELIVERY_CARDS_V1. Set on EVERY taxi
-- GO from what the app declares (an older app going online again clears it), exactly as "taxiStopsCapable" is.
--
-- Three NOT NULL columns with constant defaults: metadata-only on PostgreSQL 11+, no table rewrite, no backfill.
-- Rollback: rollback.sql.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "drivers" ADD COLUMN "takesDeliveries" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "riders" ADD COLUMN "returnsToTaxi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "drivers" ADD COLUMN "deliveryCardsCapable" BOOLEAN NOT NULL DEFAULT false;
