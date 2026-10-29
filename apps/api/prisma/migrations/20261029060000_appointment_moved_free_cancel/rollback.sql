-- Rollback of 20261029060000_appointment_moved_free_cancel: the two stamps go; the window they open closes with them
-- (cancel-policy falls back to the 2-hour rule). Run only together with the code that reads them.
ALTER TABLE "service_jobs" DROP COLUMN IF EXISTS "providerMovedAt";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "appointmentMovedAt";
