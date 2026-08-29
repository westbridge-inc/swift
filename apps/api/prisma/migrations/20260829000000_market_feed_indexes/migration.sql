-- [MKT G1] Indexes the market feed sorts on.
--
-- ADDITIVE ONLY: two indexes, no column touched, no default changed.
--
-- `popular` was already served by ("isAvailable", "totalOrdered"). `new` — the
-- "New arrivals" rail the reference makes the hero of the Market tab — and the
-- price sorts were full scans over the whole catalogue, which is exactly the
-- browse-feed collapse the marketplace spec warns about.
--
-- CONCURRENTLY is deliberately NOT used: Prisma runs migrations inside a
-- transaction, where it is not permitted. The items table is small at launch
-- depth and this takes a brief lock; it must be revisited before the catalogue
-- is large.
SET lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS "items_isAvailable_createdAt_idx"
    ON "items"("isAvailable", "createdAt");

CREATE INDEX IF NOT EXISTS "items_isAvailable_basePrice_idx"
    ON "items"("isAvailable", "basePrice");
