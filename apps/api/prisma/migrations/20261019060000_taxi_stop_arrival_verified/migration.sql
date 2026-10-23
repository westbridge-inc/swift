-- [TAXI multi-stop · COORD ruling 19 Oct, option A] A stop's billable wait counts only from an arrival the
-- E19 arrival gate accepts (a fresh fix within 300 m of the stop). The arrival itself is never refused;
-- the gate's answer is kept on the stop row, and the waiting charge reads it.
--
-- ADDITIVE ONLY: one nullable column. Every existing row keeps NULL (no rides with stops exist while
-- TAXI_MAX_STOPS=0, and a NULL is never billed: only TRUE starts a charged wait).

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "taxi_trip_stops" ADD COLUMN "arrivalVerified" BOOLEAN;
