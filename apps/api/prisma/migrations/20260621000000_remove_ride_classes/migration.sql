-- Revert taxi ride classes (Standard/Comfort/XL). V1 launches with a single
-- taxi tier: every driver is STANDARD and there is no way to mark a vehicle
-- COMFORT/XL, so the tiers could never dispatch. Reintroduce when a premium
-- fleet is onboarded (the add_ride_classes migration is the template).
--
-- Drop the columns before the enum they depend on.

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "rideClass";

-- AlterTable
ALTER TABLE "drivers" DROP COLUMN "vehicleClass";

-- DropEnum
DROP TYPE "RideClass";
