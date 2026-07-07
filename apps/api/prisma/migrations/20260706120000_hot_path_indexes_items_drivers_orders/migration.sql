-- Hot-path indexes the first pass missed (audit 2026-07-06).
-- Postgres does not auto-index FK columns; these back the hottest reads:
--   items:   vendor menu load (vendor detail / console / reorder), browse+trending
--   drivers: taxi dispatch candidate scan (mirrors riders_geo_gist)
--   orders:  driver history/active lookups, vendor order board

-- items
CREATE INDEX IF NOT EXISTS "items_vendorId_idx" ON "items"("vendorId");
CREATE INDEX IF NOT EXISTS "items_vendorId_isAvailable_idx" ON "items"("vendorId", "isAvailable");
CREATE INDEX IF NOT EXISTS "items_isAvailable_totalOrdered_idx" ON "items"("isAvailable", "totalOrdered");

-- drivers: cheap candidate filter + PostGIS expression GIST for ST_DWithin,
-- exactly like riders_geo_gist (partial: only online drivers with a fix).
CREATE INDEX IF NOT EXISTS "drivers_isOnline_isAvailable_idx" ON "drivers"("isOnline", "isAvailable");
CREATE INDEX IF NOT EXISTS "drivers_geo_gist"
ON "drivers" USING GIST (geography(ST_MakePoint("currentLng", "currentLat")))
WHERE "isOnline" = true AND "currentLat" IS NOT NULL AND "currentLng" IS NOT NULL;

-- orders
CREATE INDEX IF NOT EXISTS "orders_driverId_idx" ON "orders"("driverId");
CREATE INDEX IF NOT EXISTS "orders_vendorId_status_idx" ON "orders"("vendorId", "status");
