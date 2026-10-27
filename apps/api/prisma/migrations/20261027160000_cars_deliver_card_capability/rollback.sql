-- Rollback of 20261027160000_cars_deliver_card_capability. No taxi is offered a delivery from taxi work until an
-- app that can show one goes online again (every taxi reads as an older app).
BEGIN;
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "deliveryCardsCapable";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261027160000_cars_deliver_card_capability';
COMMIT;
