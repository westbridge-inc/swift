-- [R23 · research C10] When an inactive customer was told their account closes in 30 days.
ALTER TABLE "users" ADD COLUMN "inactivityNoticeAt" TIMESTAMP(3);
