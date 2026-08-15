-- Ride queue tenant containment: the authenticated customer's tenant is the
-- canonical owner. Repair every legacy snapshot from users before making the
-- boundary mandatory. Fail closed if an orphan would make that impossible.
-- Rollback (only before multi-tenant traffic): drop the FK/index and remove
-- NOT NULL. Never roll back the backfilled tenant values.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ride_queue_entries" q
    LEFT JOIN "users" u ON u."id" = q."customerId"
    WHERE u."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'ride queue tenant backfill blocked: orphan customerId exists';
  END IF;
END
$migration$;

UPDATE "ride_queue_entries" q
SET "tenantId" = u."tenantId"
FROM "users" u
WHERE u."id" = q."customerId"
  AND q."tenantId" IS DISTINCT FROM u."tenantId";

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ride_queue_entries" q
    JOIN "users" u ON u."id" = q."customerId"
    WHERE q."tenantId" IS NULL
       OR q."tenantId" IS DISTINCT FROM u."tenantId"
  ) THEN
    RAISE EXCEPTION 'ride queue tenant backfill did not converge to customer authority';
  END IF;
END
$migration$;

ALTER TABLE "ride_queue_entries"
  ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "ride_queue_entries"
  ADD CONSTRAINT "ride_queue_entries_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "ride_queue_entries"
  VALIDATE CONSTRAINT "ride_queue_entries_tenantId_fkey";

CREATE INDEX "ride_queue_entries_tenantId_status_expiresAt_createdAt_idx"
  ON "ride_queue_entries"("tenantId", "status", "expiresAt", "createdAt");
