ALTER TABLE "orders" ADD COLUMN "driverAssignmentVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_assignment_version_nonnegative" CHECK ("driverAssignmentVersion" >= 0);

CREATE FUNCTION advance_order_driver_assignment_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."driverId" IS DISTINCT FROM OLD."driverId" THEN
    NEW."driverAssignmentVersion" := OLD."driverAssignmentVersion" + 1;
  ELSE
    NEW."driverAssignmentVersion" := OLD."driverAssignmentVersion";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_driver_assignment_version
BEFORE UPDATE OF "driverId", "driverAssignmentVersion" ON "orders"
FOR EACH ROW EXECUTE FUNCTION advance_order_driver_assignment_version();
