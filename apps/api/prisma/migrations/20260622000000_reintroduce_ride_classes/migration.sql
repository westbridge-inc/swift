-- Reintroduce taxi ride classes (Economy/Comfort/XL) — now with a real way to
-- assign a driver's class (driver-profile API + admin drivers page), which is
-- what made the original tiers undispatchable (every driver defaulted STANDARD).
-- Renamed STANDARD -> ECONOMY vs the 20260620034716 template; the driver column
-- is `rideClass` (the top tier the vehicle serves). Existing drivers default to
-- ECONOMY.

-- CreateEnum
CREATE TYPE "RideClass" AS ENUM ('ECONOMY', 'COMFORT', 'XL');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "rideClass" "RideClass" NOT NULL DEFAULT 'ECONOMY';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "rideClass" "RideClass";

-- AlterTable
ALTER TABLE "country_configs" ADD COLUMN     "taxiClassRates" JSONB;
