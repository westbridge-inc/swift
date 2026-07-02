-- Mandatory signup selfie (master plan §3): set only by POST /auth/selfie.
-- Null → the account has not completed the camera selfie; the transact gates
-- (orders / rides / go-online) and the mobile root gate stay closed.
ALTER TABLE "users" ADD COLUMN     "selfieCapturedAt" TIMESTAMP(3);
