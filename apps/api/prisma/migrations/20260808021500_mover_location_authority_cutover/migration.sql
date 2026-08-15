-- This is an intentionally NON-ROLLING authority cutover. The deployment
-- runbook drains every old API/worker binary before this migration runs. A
-- mixed fleet would let an old process publish location without a session
-- generation and defeat the new ownership invariant.

-- The preceding expand migration must make the proof index-backed before the
-- maintenance window reaches this point. Refuse a manually-baselined or partial
-- schema instead of falling back to whole-profile scans under the cutover lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('riders_currentOrderId_idx', 'riders'),
        ('riders_isOnline_idx', 'riders'),
        ('drivers_currentRideId_idx', 'drivers'),
        ('drivers_isOnline_isAvailable_idx', 'drivers'),
        ('orders_status_idx', 'orders'),
        ('orders_riderId_idx', 'orders'),
        ('orders_driverId_idx', 'orders'),
        ('riders_isAvailable_idx', 'riders'),
        ('riders_locationSessionId_idx', 'riders'),
        ('drivers_isAvailable_idx', 'drivers'),
        ('drivers_locationSessionId_idx', 'drivers')
    ) AS required(index_name, table_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indexrelid = to_regclass(format('%I', required.index_name))
        AND i.indrelid = to_regclass(format('%I', required.table_name))
        AND i.indisvalid = true
        AND i.indisready = true
    )
  ) THEN
    RAISE EXCEPTION
      'Mover authority cutover refused: required readiness indexes are missing or invalid'
      USING HINT = 'Keep maintenance mode active. Repair/replay the readiness-index migration, verify all eleven indexes are valid, then retry the cutover.';
  END IF;
END $$;

-- Prisma's PostgreSQL migration runner does not wrap migration files in a
-- transaction by default. Keep the final proof and capability constraints
-- atomic, and bound both the drain lock and total maintenance operation. Bulk
-- profile retirement has already committed in restart-safe batches via the
-- preparation command; this transaction deliberately contains no mass UPDATE.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- The fleet must already be drained. These locks are still mandatory: they
-- close the final check/use race so an unexpected writer cannot create a new
-- assignment, custody state, or profile pointer between proof and capability
-- activation.
LOCK TABLE "orders", "riders", "drivers" IN SHARE ROW EXCLUSIVE MODE;

-- Never manufacture downtime safety by abandoning a person, passenger, meal,
-- or parcel already assigned to a mover. The migration aborts if any assignment,
-- custody state, pointer, or unretired supply remains. The latter checks are the
-- durable handshake with the resumable preparation command.
DO $$
DECLARE
  has_active_assignment BOOLEAN;
  has_physical_custody BOOLEAN;
  has_rider_live_pointer BOOLEAN;
  has_driver_live_pointer BOOLEAN;
  has_rider_pointer BOOLEAN;
  has_driver_pointer BOOLEAN;
  has_rider_supply BOOLEAN;
  has_driver_supply BOOLEAN;
BEGIN
  SELECT (
    EXISTS (
      SELECT 1
      FROM "orders" o
      WHERE o."riderId" IS NOT NULL
        AND o."status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED')
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM "orders" o
      WHERE o."driverId" IS NOT NULL
        AND o."status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED')
      LIMIT 1
    )
  ) INTO has_active_assignment;

  -- Custody is status truth, not assignment-FK truth. In particular, PIN
  -- verification and the DRIVER_ARRIVED -> RIDE_IN_PROGRESS transition are
  -- separate writes, so DRIVER_ARRIVED + either persisted verification field
  -- is already passenger custody even if an assignment pointer is missing or
  -- corrupt. Treat the timestamp as evidence even if a legacy write failed to
  -- keep the denormalized boolean in sync.
  SELECT (
    EXISTS (
      SELECT 1
      FROM "orders" o
      WHERE o."status" IN ('PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS')
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM "orders" o
      WHERE o."status" = 'DRIVER_ARRIVED'
        AND (o."ridePinVerified" = true OR o."ridePinVerifiedAt" IS NOT NULL)
      LIMIT 1
    )
  ) INTO has_physical_custody;

  -- A profile pointer to any non-terminal order is live authority evidence.
  -- The reverse order FK may be absent or point at someone else precisely in
  -- the corruption cases this guard must refuse to "heal" away.
  SELECT EXISTS (
    SELECT 1
    FROM "riders" r
    JOIN "orders" o ON o."id" = r."currentOrderId"
    WHERE o."status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED')
    LIMIT 1
  ) INTO has_rider_live_pointer;

  SELECT EXISTS (
    SELECT 1
    FROM "drivers" d
    JOIN "orders" o ON o."id" = d."currentRideId"
    WHERE o."status" NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED')
    LIMIT 1
  ) INTO has_driver_live_pointer;

  SELECT EXISTS (
    SELECT 1 FROM "riders"
    WHERE "currentOrderId" IS NOT NULL
    LIMIT 1
  ) INTO has_rider_pointer;

  SELECT EXISTS (
    SELECT 1 FROM "drivers"
    WHERE "currentRideId" IS NOT NULL
    LIMIT 1
  ) INTO has_driver_pointer;

  SELECT (
    EXISTS (
      SELECT 1 FROM "riders" WHERE "isOnline" = true LIMIT 1
    )
    OR EXISTS (
      SELECT 1 FROM "riders" WHERE "isAvailable" = true LIMIT 1
    )
    OR EXISTS (
      SELECT 1 FROM "riders" WHERE "locationSessionId" IS NOT NULL LIMIT 1
    )
  ) INTO has_rider_supply;

  SELECT (
    EXISTS (
      SELECT 1 FROM "drivers" WHERE "isOnline" = true LIMIT 1
    )
    OR EXISTS (
      SELECT 1 FROM "drivers" WHERE "isAvailable" = true LIMIT 1
    )
    OR EXISTS (
      SELECT 1 FROM "drivers" WHERE "locationSessionId" IS NOT NULL LIMIT 1
    )
  ) INTO has_driver_supply;

  IF has_active_assignment
     OR has_physical_custody
     OR has_rider_live_pointer
     OR has_driver_live_pointer
     OR has_rider_pointer
     OR has_driver_pointer
     OR has_rider_supply
     OR has_driver_supply THEN
    RAISE EXCEPTION
      'Mover authority cutover refused: assignments=%, custody=%, rider_live_pointers=%, driver_live_pointers=%, rider_pointers=%, driver_pointers=%, rider_supply=%, driver_supply=%',
      has_active_assignment,
      has_physical_custody,
      has_rider_live_pointer,
      has_driver_live_pointer,
      has_rider_pointer,
      has_driver_pointer,
      has_rider_supply,
      has_driver_supply
      USING HINT = 'Keep maintenance mode and every old writer stopped. Reconcile live work, rerun the bounded preparation command to zero, then prove this failed transaction rolled back before retrying migrate deploy.';
  END IF;
END $$;

-- Durable database capability: even if an obsolete writer reconnects after
-- the drain, it cannot recreate dispatch-eligible ownerless supply. Add as NOT
-- VALID first, then validate after retirement so readiness can require both
-- named, validated constraints as cutover proof.
ALTER TABLE "riders"
  ADD CONSTRAINT "riders_online_requires_location_owner"
  CHECK (NOT "isOnline" OR "locationSessionId" IS NOT NULL) NOT VALID;

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_online_requires_location_owner"
  CHECK (NOT "isOnline" OR "locationSessionId" IS NOT NULL) NOT VALID;

ALTER TABLE "riders"
  VALIDATE CONSTRAINT "riders_online_requires_location_owner";

ALTER TABLE "drivers"
  VALIDATE CONSTRAINT "drivers_online_requires_location_owner";

COMMIT;
