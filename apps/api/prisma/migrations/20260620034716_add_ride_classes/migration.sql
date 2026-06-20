-- CreateEnum
CREATE TYPE "RideClass" AS ENUM ('STANDARD', 'COMFORT', 'XL');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "vehicleClass" "RideClass" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "rideClass" "RideClass";
