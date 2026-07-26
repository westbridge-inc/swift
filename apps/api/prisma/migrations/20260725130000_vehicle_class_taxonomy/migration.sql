-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VehicleType" ADD VALUE 'WAGON_CAR';
ALTER TYPE "VehicleType" ADD VALUE 'BUS_9';
ALTER TYPE "VehicleType" ADD VALUE 'BUS_15';
ALTER TYPE "VehicleType" ADD VALUE 'CANTER_SHORT';
ALTER TYPE "VehicleType" ADD VALUE 'CANTER_LONG';
ALTER TYPE "VehicleType" ADD VALUE 'BOX_TRUCK_SHORT';
ALTER TYPE "VehicleType" ADD VALUE 'BOX_TRUCK_LONG';
