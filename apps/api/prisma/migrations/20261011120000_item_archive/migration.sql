-- [Item 62] Deleting a menu listing archives it: the row stays for the orders
-- and bookings that reference it. An archived listing can never be on sale
-- again, so the column comes with the rule that enforces it.
SET lock_timeout = '10s';

ALTER TABLE "items" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "items" ADD CONSTRAINT "items_archived_unavailable"
  CHECK ("archivedAt" IS NULL OR ("isAvailable" = false AND "autoHiddenAt" IS NULL));

-- [owner 11 Oct] Deleting a category archives it and its listings the same
-- way (a hard delete cascaded through items into bookings).
ALTER TABLE "categories" ADD COLUMN "archivedAt" TIMESTAMP(3);
