-- [REPORT-014 F-014-01 / REPORT-016 F-016-03] The prior heal only touched
-- vehicleCapacity=4 rows and never repaired rideClass, so a row a driver had
-- self-forged through the OLD self-service profile writer (e.g. a 4-seat CAR
-- tagged GROUP with vehicleCapacity 14) survived. There is no admin capacity
-- writer — provisioning is the only legitimate writer and it always sets the
-- taxonomy value — so EVERY non-taxonomy value is stale or forged.
--
-- The `drivers` table holds ONLY ride-capable vehicles (bikes/motorcycles/
-- cargo canters are RIDERS, no rideClass/capacity). Normalize BOTH fields to
-- the vehicle taxonomy for those four ride types (mirrors
-- src/config/vehicle-classes.ts exactly; migrations cannot import TS). Any
-- other/legacy vehicleType in this table is left untouched (rideClass is
-- NOT NULL, so we never write NULL here).
UPDATE "drivers" SET
  "vehicleCapacity" = CASE "vehicleType"
    WHEN 'CAR' THEN 4
    WHEN 'WAGON_CAR' THEN 5
    WHEN 'BUS_9' THEN 9
    WHEN 'BUS_15' THEN 15
    ELSE "vehicleCapacity" END,
  "rideClass" = CASE "vehicleType"
    WHEN 'CAR' THEN 'ECONOMY'::"RideClass"
    WHEN 'WAGON_CAR' THEN 'COMFORT'::"RideClass"
    WHEN 'BUS_9' THEN 'GROUP'::"RideClass"
    WHEN 'BUS_15' THEN 'GROUP'::"RideClass"
    ELSE "rideClass" END
WHERE "vehicleType" IN ('CAR','WAGON_CAR','BUS_9','BUS_15');
