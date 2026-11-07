-- Rollback for 20261025170000_taxi_stop_place_frozen: the stop's place and priced leg become writable again (the
-- previous function text, from 20260925000000_taxi_trip_stops). No data changes either way.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION taxi_trip_stops_identity_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
           OR NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
          RAISE EXCEPTION 'taxi_trip_stops row % is frozen: id, tenantId, orderId and sequence never change once written [TAXI multi-stop]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
COMMIT;
