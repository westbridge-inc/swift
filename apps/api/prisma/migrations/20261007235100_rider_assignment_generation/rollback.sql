DROP TRIGGER IF EXISTS orders_rider_assignment_version ON "orders";
DROP FUNCTION IF EXISTS advance_order_rider_assignment_version();
ALTER TABLE "orders" DROP COLUMN IF EXISTS "riderAssignmentVersion";
