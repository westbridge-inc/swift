-- Removes only this constraint; leaves recorded cash facts intact.
SET lock_timeout = '10s';
ALTER TABLE "orders" DROP CONSTRAINT "orders_door_cash_finite";
