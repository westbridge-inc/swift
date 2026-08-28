-- =========================================================================
-- db-posture.sql — the database's security and load posture, in one run.
--
--   docker exec -i swift-postgres psql -U swift -d swift -f - < scripts/db-posture.sql
--   psql "$DATABASE_URL" -f scripts/db-posture.sql          # any environment
--
-- This is the read-only "Movement 0" SQL block from the guardrails programme
-- (GRD-1 §, tailored). It answers questions the application's own test suite
-- structurally CANNOT answer, because they are properties of the database and
-- the role it is reached through, not of the code.
--
-- Every check below says what a GOOD answer looks like, so the output is
-- readable by someone who did not write the queries. Nothing here writes.
--
-- Run it against every environment you care about. The answers differ per
-- environment by design — that is the point.
-- =========================================================================

\echo ''
\echo '=== 1. ROLE PRIVILEGES ==================================================='
\echo 'GOOD: the role the APPLICATION connects as has super=f and bypassrls=f.'
\echo 'A superuser or a BYPASSRLS role is exempt from every row-level policy,'
\echo 'so RLS below is decoration for that connection however many policies exist.'
SELECT rolname,
       rolsuper     AS is_superuser,
       rolbypassrls AS bypasses_rls,
       rolcreatedb  AS can_create_db,
       rolcreaterole AS can_create_role,
       rolcanlogin  AS can_login
FROM pg_roles
WHERE rolname NOT LIKE 'pg\_%'
ORDER BY rolsuper DESC, rolname;

\echo ''
\echo '=== 2. WHO OWNS THE TABLES =============================================='
\echo 'GOOD: the application role is NOT the owner. A table owner bypasses'
\echo 'row-level security unless that table is explicitly FORCED (check 3).'
SELECT tableowner, count(*) AS tables
FROM pg_tables WHERE schemaname = 'public'
GROUP BY tableowner ORDER BY tables DESC;

\echo ''
\echo '=== 3. RLS: ENABLED vs FORCED =========================================='
\echo 'This is the check a policy COUNT cannot make, and the two mean different'
\echo 'things: ENABLE applies policies to ordinary roles; FORCE also applies them'
\echo 'to the table OWNER. If the app connects as the owner and FORCE is off, the'
\echo 'policies never constrain the application at all.'
\echo 'GOOD: forced == enabled, and the app connects as a non-owner role.'
SELECT count(*)                                    AS tables_total,
       count(*) FILTER (WHERE relrowsecurity)      AS rls_enabled,
       count(*) FILTER (WHERE relforcerowsecurity) AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public';

\echo ''
\echo '--- tables with RLS enabled but NOT forced (first 20) ---'
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
  AND c.relrowsecurity AND NOT c.relforcerowsecurity
ORDER BY 1 LIMIT 20;

\echo ''
\echo '--- tables carrying a tenantId column but NO policy at all ---'
\echo 'GOOD: zero rows. A tenant-bearing table with no policy is a hole even'
\echo 'once FORCE is on.'
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND a.attnum > 0
WHERE c.relkind = 'r' AND n.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
ORDER BY 1;

\echo ''
\echo '=== 4. MONEY STORED AS FLOAT ==========================================='
\echo 'GOOD: no money column appears here. Floating point cannot represent'
\echo 'decimal currency exactly, so a total computed from it drifts by cents.'
\echo 'Coordinates, ratings, rates and multipliers ARE legitimately float —'
\echo 'read the list, do not just count it.'
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND data_type IN ('double precision', 'real')
ORDER BY table_name, column_name;

\echo ''
\echo '=== 5. CONNECTION AND STATEMENT BUDGETS ================================'
\echo 'GOOD: max_connections comfortably exceeds the sum of every process pool'
\echo '(API replicas x DB_POOL_SIZE_API + worker x DB_POOL_SIZE_WORKER + tools).'
\echo 'GOOD: statement_timeout, lock_timeout and idle_in_transaction_session_timeout'
\echo 'are NON-ZERO for the application role. Zero means a single stuck query can'
\echo 'hold a connection forever; idle_in_transaction is the one that eats the'
\echo 'pool while every dashboard still looks healthy.'
SELECT name, setting, unit
FROM pg_settings
WHERE name IN ('max_connections', 'statement_timeout', 'lock_timeout',
               'idle_in_transaction_session_timeout', 'shared_buffers')
ORDER BY name;

\echo ''
\echo '--- per-role overrides (these are what actually bind the app) ---'
SELECT r.rolname, s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
ORDER BY r.rolname;

\echo ''
\echo '=== 6. CURRENT CONNECTION USE =========================================='
\echo 'GOOD: total well under max_connections, and idle_in_transaction near zero.'
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state ORDER BY count DESC;

\echo ''
\echo '=== 7. SEQUENTIAL IDS ON EXTERNALLY-VISIBLE TABLES ====================='
\echo 'GOOD: zero. Sequential ids let an outsider enumerate and size the'
\echo 'business. This schema uses cuid() by convention — this proves it held.'
SELECT count(*) AS nextval_id_columns
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'id'
  AND column_default LIKE 'nextval%';

\echo ''
\echo '=== 8. UNINDEXED FOREIGN KEYS =========================================='
\echo 'GOOD: few, and none on a hot table. An unindexed FK makes every parent'
\echo 'DELETE or UPDATE scan the child table, and makes the join that follows'
\echo 'the relation a sequential scan.'
SELECT count(*) AS unindexed_single_column_fks
FROM pg_constraint c
WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
  );

\echo ''
\echo '--- the biggest offenders, by table size (first 15) ---'
SELECT c.conrelid::regclass AS table_name,
       a.attname            AS fk_column,
       pg_size_pretty(pg_total_relation_size(c.conrelid)) AS table_size
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
  )
ORDER BY pg_total_relation_size(c.conrelid) DESC
LIMIT 15;

\echo ''
\echo '=== 9. THE FASTEST-GROWING TABLES ======================================'
\echo 'Cross-check against the retention registry: anything large and growing'
\echo 'that has no retention class is an unbounded table (P3).'
SELECT relname AS table_name,
       n_live_tup AS approx_rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC
LIMIT 15;

\echo ''
\echo '=== 10. SEQUENTIAL SCANS ON BIG TABLES ================================='
\echo 'GOOD: seq_scan low relative to idx_scan on anything with real row counts.'
\echo 'A big table read mostly by sequential scan is a missing index.'
SELECT relname AS table_name, seq_scan, idx_scan, n_live_tup AS approx_rows
FROM pg_stat_user_tables
WHERE n_live_tup > 1000
ORDER BY seq_scan DESC
LIMIT 15;

\echo ''
\echo '=== END. Record the answers with the date and the environment. ========='
