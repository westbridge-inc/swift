-- Step 8: geospatial mover lookup.
-- PostGIS over the existing float columns with an expression GIST index —
-- no geometry column needed at Guyana scale, and the index keeps ST_DWithin
-- candidate scans cheap as rider counts grow.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE INDEX IF NOT EXISTS "riders_geo_gist"
ON "riders" USING GIST (geography(ST_MakePoint("currentLng", "currentLat")))
WHERE "isOnline" = true AND "currentLat" IS NOT NULL AND "currentLng" IS NOT NULL;
