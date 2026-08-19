-- [REPORT-014 F-014-03] SupplyWatch gains tenant identity so demand counts
-- and recovery notifications stay inside the watcher's tenant.
ALTER TABLE "supply_watches" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'swift-default';

-- [REPORT-014 F-014-01] Data heal: vehicleCapacity was never derived from the
-- vehicle taxonomy at provisioning, so every driver sat at the schema default
-- of 4 regardless of the physical vehicle. Values mirror
-- src/config/vehicle-classes.ts `seats` exactly (the taxonomy is the
-- authority; this literal copy exists because migrations cannot import
-- TypeScript). Only untouched defaults (=4) are healed, so any deliberate
-- admin-set capacity survives.
UPDATE "drivers" SET "vehicleCapacity" = CASE "vehicleType"
  WHEN 'BICYCLE' THEN 0
  WHEN 'MOTORCYCLE' THEN 0
  WHEN 'WAGON_CAR' THEN 5
  WHEN 'BUS_9' THEN 9
  WHEN 'BUS_15' THEN 15
  WHEN 'CANTER_SHORT' THEN 0
  WHEN 'CANTER_LONG' THEN 0
  ELSE "vehicleCapacity" END
WHERE "vehicleCapacity" = 4 AND "vehicleType" IN ('BICYCLE','MOTORCYCLE','WAGON_CAR','BUS_9','BUS_15','CANTER_SHORT','CANTER_LONG');
