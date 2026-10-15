-- [R23 · research C10] When an inactive customer was told their account closes in 30 days.
-- EXPAND only: one nullable column, metadata-only; the lock timeout keeps it from queueing
-- sign-ins behind a long transaction.
SET lock_timeout = '10s';
ALTER TABLE "users" ADD COLUMN "inactivityNoticeAt" TIMESTAMP(3);
