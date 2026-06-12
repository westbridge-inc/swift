-- AlterTable
ALTER TABLE "country_configs" ADD COLUMN     "taxiRates" JSONB;

-- CreateTable
CREATE TABLE "zone_fares" (
    "id" TEXT NOT NULL,
    "fromZoneId" TEXT NOT NULL,
    "toZoneId" TEXT NOT NULL,
    "fare" DECIMAL(10,2) NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zone_fares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zone_fares_fromZoneId_toZoneId_key" ON "zone_fares"("fromZoneId", "toZoneId");

-- AddForeignKey
ALTER TABLE "zone_fares" ADD CONSTRAINT "zone_fares_fromZoneId_fkey" FOREIGN KEY ("fromZoneId") REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_fares" ADD CONSTRAINT "zone_fares_toZoneId_fkey" FOREIGN KEY ("toZoneId") REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

