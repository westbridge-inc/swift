-- [SEARCH] Customer search reads pieces of names and descriptions: every word
-- as typed (ILIKE '%word%') and, from five letters, one-slip patterns anchored
-- at a word start (ILIKE 'w_rd%' / '% w_rd%'). With only btree indexes each
-- search read every available item; trigram GIN indexes turn those reads into
-- index lookups. Owner decision 26 (13 Oct): "yes, one reviewed migration".
--
-- pg_trgm is a contrib extension shipped in the postgres image the platform
-- runs (postgis/postgis:16-3.4). Plain CREATE INDEX: Prisma runs a migration
-- in one transaction (no CONCURRENTLY), and at launch catalogue sizes the
-- build takes well under a second; a write to these tables waits for it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "items_name_trgm_idx" ON "items" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "items_description_trgm_idx" ON "items" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "vendors_name_trgm_idx" ON "vendors" USING GIN ("name" gin_trgm_ops);
