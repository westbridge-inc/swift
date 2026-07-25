-- FUL-007: kitchen-capacity guard. Additive, nullable — existing vendors keep
-- unlimited intake (NULL) until an owner opts into a cap.
ALTER TABLE "vendors" ADD COLUMN "maxConcurrentOrders" INTEGER;
