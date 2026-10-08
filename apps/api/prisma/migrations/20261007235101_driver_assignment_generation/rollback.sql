DROP TRIGGER IF EXISTS orders_driver_assignment_version ON "orders";
DROP FUNCTION IF EXISTS advance_order_driver_assignment_version();
ALTER TABLE "orders" DROP COLUMN IF EXISTS "driverAssignmentVersion";
