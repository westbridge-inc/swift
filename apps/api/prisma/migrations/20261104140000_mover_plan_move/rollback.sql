-- [BUG-HUNT F05] Rollback of 20261104140000_mover_plan_move: roll the application back first (it writes these).
SET lock_timeout = '10s';
ALTER TABLE "users" DROP COLUMN IF EXISTS "moverPlanMoveBy";
ALTER TABLE "users" DROP COLUMN IF EXISTS "moverPlanMoveUntil";
