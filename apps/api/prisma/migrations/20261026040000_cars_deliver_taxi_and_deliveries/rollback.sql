-- Rollback of 20261026040000_cars_deliver_taxi_and_deliveries. Every "taxi + deliveries" choice and every
-- pending return to taxi work is forgotten (taxi rides only, the default).
BEGIN;
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "takesDeliveries";
ALTER TABLE "riders" DROP COLUMN IF EXISTS "returnsToTaxi";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261026040000_cars_deliver_taxi_and_deliveries';
COMMIT;
