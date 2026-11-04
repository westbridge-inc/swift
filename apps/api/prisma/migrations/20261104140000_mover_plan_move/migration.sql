-- [BUG-HUNT F05 · COORD 4 Nov 2026] Support allows one move between delivery and taxi work, for a week. The person makes
-- the move in the app; these say until when, and who allowed it. EXPAND only: two nullable columns on users.
--
-- ROLLBACK: rollback.sql beside this file (drops both; roll the application back first).
SET lock_timeout = '10s';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "moverPlanMoveUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "moverPlanMoveBy" TEXT;
