-- [CARS-DELIVER PR4 · REVIEW-F #2139 S2-2, REVIEW-G #2138 S2-2, REVIEW-M #2138 S2-1; COORD ruling 27 Oct: the
-- TAXI_STOPS_V1 pattern] "Taxi + deliveries" offers a delivery only to a taxi GO whose app can show a delivery card.
--
-- drivers."deliveryCardsCapable": the app on this taxi's last GO declared CAR_DELIVERY_CARDS_V1. Set on EVERY taxi
-- GO from what the app declares (an older app going online again clears it), exactly as "taxiStopsCapable" is.
-- Default false: no taxi is offered a delivery from taxi work until an app that can show one goes online.
--
-- One NOT NULL column with a constant default: metadata-only on PostgreSQL 11+, no table rewrite, no backfill.
-- Rollback: rollback.sql.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "drivers" ADD COLUMN "deliveryCardsCapable" BOOLEAN NOT NULL DEFAULT false;
