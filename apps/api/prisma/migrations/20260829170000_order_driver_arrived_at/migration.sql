-- [Band F] The clock-starting moment had no timestamp of its own.
--
-- `DRIVER_ARRIVED` is what starts the customer's waiting clock, and every
-- no-show and waiting-fee decision in SWIFT_KERB_AND_COCKPIT.md hangs off it.
-- Until now the only record of when it happened was the status-log row, which
-- is the right place for evidence but the wrong place for a clock: reading it
-- means scanning a log for the newest row of a given status, and any code that
-- needs "how long have they been waiting" would have to re-derive it.
--
-- `Order.arrivedAt` on RunStop already exists for the batching model; this is
-- the order-level equivalent, and it is deliberately NOT called `arrivedAt` so
-- the two can never be confused in a query.
--
-- ADDITIVE ONLY: one nullable column. Nothing reads it until a clock does, and
-- a NULL means exactly what it means today — nobody has reported arriving.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "orders" ADD COLUMN "driverArrivedAt" TIMESTAMP(3);
