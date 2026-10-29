-- [BOOK-P3 · COORD ruling 29 Oct 2026 (b)] When a business or provider moves a confirmed appointment, the customer
-- can cancel it free in the app for 60 minutes after being told (Terms s7). Two nullable stamps, written by the move
-- itself; no backfill (a move made before this has no window, the rule it was made under).
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "appointmentMovedAt" TIMESTAMP(3);
ALTER TABLE "service_jobs" ADD COLUMN "providerMovedAt" TIMESTAMP(3);
