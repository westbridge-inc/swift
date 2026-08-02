-- CreateEnum
CREATE TYPE "VehicleBodyType" AS ENUM ('SEDAN', 'HATCHBACK', 'WAGON', 'SUV', 'PICKUP', 'MINIBUS', 'COMPACT', 'UNKNOWN');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "bodyType" "VehicleBodyType",
ADD COLUMN     "colorHex" TEXT;

