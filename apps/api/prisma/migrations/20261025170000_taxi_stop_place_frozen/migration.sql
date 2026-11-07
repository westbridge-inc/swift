-- [REVIEW-M S4-1 · multi-stop switch-on review, 22 Oct] A taxi stop's place (lat, lng, address) and its priced leg
-- (legMeters, legSeconds) are the evidence the ride's fare was priced from: the whole route is priced ONCE at
-- request and the server books only at that fare. They are frozen like the stop's ride, tenant and place in the
-- order. No app writer changes them (a different itinerary is a different request). Status, its timestamps, the
-- arrival's verification, the skip reason, the actor and the evidence note stay writable: they are how the ride
-- progresses.
--
-- FUNCTION ONLY: CREATE OR REPLACE of the existing trigger function (the trigger itself is unchanged and fires on
-- every UPDATE). No column, no data change. Rollback: rollback.sql restores the previous function text.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION taxi_trip_stops_identity_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
           OR NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
          RAISE EXCEPTION 'taxi_trip_stops row % is frozen: id, tenantId, orderId and sequence never change once written [TAXI multi-stop]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."lat" IS DISTINCT FROM OLD."lat"
           OR NEW."lng" IS DISTINCT FROM OLD."lng"
           OR NEW."address" IS DISTINCT FROM OLD."address"
           OR NEW."legMeters" IS DISTINCT FROM OLD."legMeters"
           OR NEW."legSeconds" IS DISTINCT FROM OLD."legSeconds" THEN
          RAISE EXCEPTION 'taxi_trip_stops row % is frozen: the place and the priced leg are the fare''s evidence and never change once written [TAXI multi-stop]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
