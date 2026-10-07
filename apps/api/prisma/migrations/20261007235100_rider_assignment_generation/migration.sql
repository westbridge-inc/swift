ALTER TABLE "orders" ADD COLUMN "riderAssignmentVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD CONSTRAINT "orders_rider_assignment_version_nonnegative" CHECK ("riderAssignmentVersion" >= 0);

CREATE FUNCTION advance_order_rider_assignment_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."riderId" IS DISTINCT FROM OLD."riderId" THEN
    NEW."riderAssignmentVersion" := OLD."riderAssignmentVersion" + 1;
  ELSE
    NEW."riderAssignmentVersion" := OLD."riderAssignmentVersion";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_rider_assignment_version
BEFORE UPDATE OF "riderId", "riderAssignmentVersion" ON "orders"
FOR EACH ROW EXECUTE FUNCTION advance_order_rider_assignment_version();
