-- Rollback of 20261106050000_cars_by_plate. Every "taxi + deliveries" choice and every pending return to taxi
-- work is forgotten (taxi rides only, the default); every taxi reads as an older app again.
BEGIN;
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "deliveryCardsCapable";
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "takesDeliveries";
ALTER TABLE "riders" DROP COLUMN IF EXISTS "returnsToTaxi";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106050000_cars_by_plate';
COMMIT;
