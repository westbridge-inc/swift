-- Priority (express) delivery for goods orders: 1.5x delivery fee, dispatch
-- priority, premium goes to the rider.
ALTER TABLE "orders" ADD COLUMN "isExpress" BOOLEAN NOT NULL DEFAULT false;
