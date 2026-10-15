-- [TA-S0-003 · C1] Rows the connected login can see in the walled tables
-- (public tables carrying a "tenantId" column, the census's own definition),
-- summed. Read-only. deploy/wall/rehearsal.sh runs it on the rehearsal copy
-- through each runtime login on a new connection: the request login, bound
-- to no tenant, must see 0; the system login (a swift_bypass_rls member) must
-- see the copy's rows. Prints one number, never a row.
SELECT coalesce(sum((xpath('/row/n/text()',
         query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
 WHERE c.relkind IN ('r', 'p')
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
   AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
