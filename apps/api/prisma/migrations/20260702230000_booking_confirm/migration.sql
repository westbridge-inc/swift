-- Booking accept/decline (master plan §4.3): providers confirm the slot.
ALTER TABLE "service_jobs" ADD COLUMN     "providerConfirmedAt" TIMESTAMP(3);
