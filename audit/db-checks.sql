-- audit/db-checks.sql — run against a DEV or STAGING database, never prod:
--   psql "$DATABASE_URL" -X -f audit/db-checks.sql
-- Read-only. Every section prints rows that are FINDINGS (empty = clean).

\pset format aligned
\pset footer off

\echo
\echo '=== 1. Tables WITHOUT row-level security enabled (multi-tenant S0 candidates) ==='
SELECT n.nspname AS schema, c.relname AS table
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_%'
  AND c.relname NOT IN ('_prisma_migrations')
  AND NOT c.relrowsecurity
ORDER BY 1,2;

\echo
\echo '=== 2. Tables with RLS enabled but NOT forced (table owner bypasses policies) ==='
SELECT n.nspname AS schema, c.relname AS table
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
  AND c.relrowsecurity AND NOT c.relforcerowsecurity
ORDER BY 1,2;

\echo
\echo '=== 3. RLS-enabled tables with ZERO policies (RLS on + no policy = deny all, or silently broken) ==='
SELECT c.relname AS table
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public' AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
ORDER BY 1;

\echo
\echo '=== 4. Tables with no tenant column (tenant_id / tenantId) — confirm each is truly platform-global ==='
SELECT t.table_name
FROM information_schema.tables t
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
  AND t.table_name NOT IN ('_prisma_migrations')
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
      AND c.column_name IN ('tenant_id','tenantId','tenantid')
  )
ORDER BY 1;

\echo
\echo '=== 5. Money-looking columns stored as FLOAT (violates integer-minor-units invariant) ==='
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type IN ('real','double precision')
  AND column_name ~* '(amount|price|fee|total|cost|balance|earning|payout|subtotal|tax|tip|fare|float|cash|owed|debt)'
ORDER BY 1,2;

\echo
\echo '=== 5b. Money-looking columns stored as NUMERIC (exact, but review: standard says integer minor units) ==='
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type = 'numeric'
  AND column_name ~* '(amount|price|fee|total|cost|balance|earning|payout|subtotal|tax|tip|fare|cash|owed|debt)'
ORDER BY 1,2;

\echo
\echo '=== 6. Foreign keys with no index on the referencing column (slow joins/deletes, lock storms) ==='
SELECT c.conrelid::regclass AS "table",
       a.attname            AS "column",
       c.confrelid::regclass AS references
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum
  )
ORDER BY 1,2;

\echo
\echo '=== 7. Tables without a primary key ==='
SELECT c.relname AS table
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p')
ORDER BY 1;

\echo
\echo '=== 8. Roles that bypass RLS or are superuser (the app role must NOT appear here) ==='
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE (rolsuper OR rolbypassrls) AND rolname NOT LIKE 'pg_%'
ORDER BY 1;

\echo
\echo '=== 9. Current connection role + whether it owns tables (owner bypasses non-forced RLS) ==='
SELECT current_user AS connected_as,
       (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner = current_user) AS tables_owned;

\echo
\echo '=== 10. Timestamp columns without time zone (silent UTC bugs across GY/TT/JM/BB) ==='
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
ORDER BY 1,2;

\echo
\echo '=== 11. Enum/state columns with no CHECK or enum type (free-text state = unenforced state machine) ==='
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type IN ('text','character varying')
  AND column_name ~* '^(status|state|stage|phase)$'
ORDER BY 1,2;

\echo
\echo '=== 12. Largest tables (rows / size) — where load will bite first ==='
SELECT relname AS table, n_live_tup AS approx_rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 15;

\echo
\echo '=== 13. Sequential-scan heavy tables (missing index candidates; needs some traffic to be meaningful) ==='
SELECT relname, seq_scan, idx_scan, n_live_tup
FROM pg_stat_user_tables
WHERE n_live_tup > 1000 AND seq_scan > idx_scan
ORDER BY seq_scan DESC
LIMIT 15;

\echo
\echo '=== 14. Triggers per table (state-machine enforcement should show up here for orders/trips) ==='
SELECT event_object_table AS table, trigger_name, event_manipulation AS event
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY 1,2;
