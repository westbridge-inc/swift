-- [DISPATCH 1/3] Exactly one winner, backed by the database.
--
-- Owner, 09-24: "if nearby drivers get pinged and one accepts, it stops ringing and
-- the others can't accept; make sure nothing bugs here and 2 taxis never go to one
-- customer." Plan: swift-coordination/DISPATCH-HARDENING-PLAN-20260924.md.
--
-- Every assigning path already serializes on the mover's users row, then the orders
-- row, and compare-and-sets both the order and the mover. Nothing in the schema said
-- so: a future writer that skipped a lock, or a hand-run repair, could still put one
-- driver on two live rides or give one customer two live taxis. These two partial
-- unique indexes make both states impossible in storage, whatever the application does:
--
--   orders_one_live_taxi_per_driver_key    a driver holds at most ONE live taxi ride
--   orders_one_live_taxi_per_customer_key  a customer has at most ONE live taxi request
--
-- LIVE is LIVE_ORDER_STATUSES in src/modules/order/order-status.ts (every status whose
-- custody class is not FINISHED). SQL cannot import it, so the list is written out
-- below and PINNED by src/__tests__/dispatch-races.test.ts, which reads this file AND
-- the installed index predicates and fails if either differs from the TypeScript set.
-- A new OrderStatus therefore fails that test until a follow-up migration re-creates
-- both indexes with the new list.
--
-- Unassigned rides never collide on the driver index: a unique index treats NULL
-- driverIds as distinct. Deliveries are untouched: a rider may stack legs
-- (stacking.riderCapacity), a taxi driver never may (concurrency-policy.ts keeps the
-- DRIVER capacity a literal 1).
--
-- PRE-CHECK (run on the target first; both counts must be 0):
--   SELECT count(*) AS drivers_with_two_live_rides FROM (
--     SELECT "driverId" FROM "orders"
--     WHERE "orderType" = 'TAXI' AND "driverId" IS NOT NULL
--       AND "status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED')
--     GROUP BY "driverId" HAVING count(*) > 1) d;
--   SELECT count(*) AS customers_with_two_live_taxis FROM (
--     SELECT "customerId" FROM "orders"
--     WHERE "orderType" = 'TAXI'
--       AND "status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED')
--     GROUP BY "customerId" HAVING count(*) > 1) c;
-- (NOT IN the six terminal statuses is the same set as IN the fifteen live ones.)
-- The DO block below runs the same check and refuses with both counts; if either is
-- not 0 this migration fails as a whole, creating nothing: settle the duplicate rides
-- by hand first, then deploy again.
--
-- Plain CREATE, not CONCURRENTLY: this file holds two statements, and Prisma runs a
-- multi-statement migration in one transaction, where CONCURRENTLY is forbidden (see
-- 20260808020000_mover_authority_readiness_indexes). The lock_timeout bounds only the
-- WAIT for the SHARE lock, so a busy table fails fast instead of queueing writers
-- behind a waiting build; the build itself then holds that lock, and writes to
-- "orders" wait for it. At pilot scale that is well under a second. Before "orders"
-- is large, build these two indexes CONCURRENTLY by hand first, one statement per
-- session, then mark this migration applied.
--
-- ROLLBACK (forward repair is preferred; dropping the indexes removes only the belt,
-- the application locks stay):
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   DROP INDEX "orders_one_live_taxi_per_driver_key";
--   DROP INDEX "orders_one_live_taxi_per_customer_key";
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925000200_dispatch_single_winner';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;

SET lock_timeout = '10s';

-- The PRE-CHECK, enforced: a readable refusal naming both counts, in place of a raw
-- unique-violation from the index build below. Same live list as the indexes.
DO $$
DECLARE
  drivers integer;
  customers integer;
BEGIN
  SELECT count(*) INTO drivers FROM (
    SELECT "driverId" FROM "orders"
    WHERE "orderType" = 'TAXI' AND "driverId" IS NOT NULL
      AND "status" IN (
        'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
        'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
        'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RETURNING',
        'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'
      )
    GROUP BY "driverId" HAVING count(*) > 1) d;
  SELECT count(*) INTO customers FROM (
    SELECT "customerId" FROM "orders"
    WHERE "orderType" = 'TAXI'
      AND "status" IN (
        'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
        'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
        'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RETURNING',
        'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'
      )
    GROUP BY "customerId" HAVING count(*) > 1) c;
  IF drivers > 0 OR customers > 0 THEN
    RAISE EXCEPTION 'dispatch_single_winner: % driver(s) hold more than one live taxi ride and % customer(s) hold more than one live taxi; settle them by hand (see the PRE-CHECK in this migration), then deploy again', drivers, customers;
  END IF;
END $$;

CREATE UNIQUE INDEX "orders_one_live_taxi_per_driver_key"
  ON "orders" ("driverId")
  WHERE "orderType" = 'TAXI'
    AND "status" IN (
      'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
      'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
      'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RETURNING',
      'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'
    );

CREATE UNIQUE INDEX "orders_one_live_taxi_per_customer_key"
  ON "orders" ("customerId")
  WHERE "orderType" = 'TAXI'
    AND "status" IN (
      'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
      'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
      'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RETURNING',
      'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'
    );
