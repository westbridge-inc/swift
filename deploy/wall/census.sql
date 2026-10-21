-- [TA-S0-003 · R2] The login catalogue, read as the migration owner. Read-only.
--
-- deploy/wall/operator.py pipes this into psql inside the postgres container
-- and hands the one JSON line it prints to logins.plan(). Every field is a
-- name, a count, a boolean or a sha256 digest: no credential, no row data.
-- The field meanings are the planner's (deploy/wall/logins.py):
--   cluster/database/migration/migrationOwner/ownershipDigest/aclDigest
--     the target fingerprint an operator approves before any write;
--   tenantTables/disabledTables/unforcedTables
--     the wall itself (tables with a "tenantId" column, ENABLE and FORCE);
--   qrSchemaPresent/qrUnsafeGrants
--     the private QR registry: no privilege for PUBLIC, the app roles or the logins
--     (schema, relations, columns, functions);
--   obsoleteExecutable
--     the dropped vendor-move functions, if any came back, executable by them;
--   parentUpdateMissing
--     swift_app keeps UPDATE on vendors and qr_codes (parent row locks need it);
--   appendOnlyUnsafeGrants
--     privileges the migrations took back from swift_app that it holds again,
--     and TRUNCATE (which skips the append-only row triggers) for any of them;
--   defaultGrantCount
--     default privileges beyond the three swift_app grants the migrations make;
--   groupUnsafeAttributes/groupUnexpectedParents/groupOwnedObjects
--     swift_app and swift_bypass_rls stay NOLOGIN groups that belong to nothing
--     and own nothing (pg_shdepend, the whole cluster): a login that inherits
--     an owner's rights can switch the wall off;
--   roles
--     the two runtime logins, when they exist: attributes, memberships,
--     ownership and grants (pg_shdepend, the whole cluster), settings by NAME.
-- A missing piece fails the query or reads as unsafe; it never reads as clean.
SET search_path = pg_catalog;
WITH
owner AS (
  SELECT r.oid, r.rolname::text AS name, r.rolsuper, r.rolbypassrls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_roles r ON r.oid = c.relowner
   WHERE c.relname = '_prisma_migrations' AND c.relkind = 'r'
),
grp AS (
  SELECT g.name, r.oid, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication
    FROM (VALUES ('swift_app'), ('swift_bypass_rls')) AS g(name)
    LEFT JOIN pg_roles r ON r.rolname = g.name
),
-- PUBLIC (oid 0), the two groups and the two logins: whoever the wall restricts.
watched AS (
  SELECT 0::oid AS oid
  UNION ALL
  SELECT oid FROM pg_roles WHERE rolname IN ('swift_app', 'swift_bypass_rls', 'swift_app_login', 'swift_system_login')
),
schemas AS (
  SELECT oid, nspname::text AS nspname, nspowner, nspacl FROM pg_namespace WHERE nspname IN ('public', 'swift_qr')
),
tenant AS (
  SELECT c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
),
qr_grants AS (
  SELECT x.grantee FROM schemas s, aclexplode(coalesce(s.nspacl, acldefault('n', s.nspowner))) x
   WHERE s.nspname = 'swift_qr'
  UNION ALL
  SELECT x.grantee
    FROM pg_class c JOIN schemas s ON s.oid = c.relnamespace AND s.nspname = 'swift_qr',
         aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) x
  UNION ALL
  SELECT x.grantee
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN schemas s ON s.oid = c.relnamespace AND s.nspname = 'swift_qr',
         aclexplode(a.attacl) x
   WHERE a.attacl IS NOT NULL AND NOT a.attisdropped
  UNION ALL
  SELECT x.grantee
    FROM pg_proc p JOIN schemas s ON s.oid = p.pronamespace AND s.nspname = 'swift_qr',
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
),
-- [APP_ROLE_MIGRATION_REVOCATIONS in apps/api/src/lib/tenant-rls.ts; a deploy
-- test pins this list to that one]
revoked(rel, priv) AS (
  VALUES ('public.provider_payment_aliases', 'INSERT'), ('public.provider_payment_aliases', 'UPDATE'),
         ('public.provider_payment_aliases', 'DELETE'),
         ('public.billing_dunning_clocks', 'DELETE'),
         ('public.payment_confirmation_holds', 'DELETE'),
         ('public.billing_fee_notices', 'DELETE'),
         ('public.billing_notice_handoffs', 'DELETE'),
         ('public.billing_obligation_transitions', 'UPDATE'), ('public.billing_obligation_transitions', 'DELETE'),
         ('public.erasure_ledger_entry', 'INSERT'), ('public.erasure_ledger_entry', 'UPDATE'), ('public.erasure_ledger_entry', 'DELETE'),
         ('public.erasure_ledger_shipment', 'INSERT'), ('public.erasure_ledger_shipment', 'UPDATE'), ('public.erasure_ledger_shipment', 'DELETE'),
         ('swift_qr.token_identities', 'SELECT'), ('swift_qr.token_identities', 'INSERT'),
         ('swift_qr.token_identities', 'UPDATE'), ('swift_qr.token_identities', 'DELETE'),
         ('swift_qr.token_identities', 'TRUNCATE'), ('swift_qr.token_identities', 'REFERENCES'),
         ('swift_qr.token_identities', 'TRIGGER')
),
app AS (SELECT oid FROM pg_roles WHERE rolname = 'swift_app'),
ownership AS (
  SELECT 'n|' || s.nspname || '|' || pg_get_userbyid(s.nspowner) AS line FROM schemas s
  UNION ALL
  SELECT 'c|' || s.nspname || '|' || c.relname || '|' || c.relkind::text || '|' || pg_get_userbyid(c.relowner)
    FROM pg_class c JOIN schemas s ON s.oid = c.relnamespace
  UNION ALL
  SELECT 'p|' || p.oid::regprocedure::text || '|' || pg_get_userbyid(p.proowner)
    FROM pg_proc p JOIN schemas s ON s.oid = p.pronamespace
  UNION ALL
  SELECT 't|' || s.nspname || '|' || t.typname || '|' || pg_get_userbyid(t.typowner)
    FROM pg_type t JOIN schemas s ON s.oid = t.typnamespace
   WHERE t.typtype IN ('e', 'd', 'r', 'm')
  UNION ALL
  SELECT 'd|' || d.datname || '|' || pg_get_userbyid(d.datdba) FROM pg_database d WHERE d.datname = current_database()
),
acls AS (
  -- One line per privilege, defaults made explicit (acldefault) and order-free,
  -- so an ACL a migration wrote out in full and the same ACL left at its
  -- default (as a pg_dump/pg_restore copy leaves it) digest alike.
  SELECT 'n|' || s.nspname || '|' || x.line AS line
    FROM schemas s, LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                                    || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                               FROM aclexplode(coalesce(s.nspacl, acldefault('n', s.nspowner))) e) x
  UNION ALL
  SELECT 'c|' || s.nspname || '|' || c.relname || '|' || x.line
    FROM pg_class c JOIN schemas s ON s.oid = c.relnamespace,
         LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                         || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                    FROM aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) e) x
  UNION ALL
  SELECT 'a|' || s.nspname || '|' || c.relname || '|' || a.attname || '|' || x.line
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN schemas s ON s.oid = c.relnamespace,
         LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                         || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                    FROM aclexplode(a.attacl) e) x
   WHERE a.attacl IS NOT NULL
  UNION ALL
  SELECT 'p|' || p.oid::regprocedure::text || '|' || x.line
    FROM pg_proc p JOIN schemas s ON s.oid = p.pronamespace,
         LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                         || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                    FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e) x
  UNION ALL
  SELECT 't|' || s.nspname || '|' || t.typname || '|' || x.line
    FROM pg_type t JOIN schemas s ON s.oid = t.typnamespace,
         LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                         || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                    FROM aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) e) x
   WHERE t.typtype IN ('e', 'd', 'r', 'm')
  UNION ALL
  SELECT 'D|' || pg_get_userbyid(d.defaclrole) || '|' || coalesce(d.defaclnamespace::regnamespace::text, '*') || '|'
         || d.defaclobjtype::text || '|' || x.line
    FROM pg_default_acl d,
         LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                         || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                    FROM aclexplode(d.defaclacl) e) x
  UNION ALL
  SELECT 'd|' || d.datname || '|' || x.line
    FROM pg_database d,
         LATERAL (SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || '|'
                         || pg_get_userbyid(e.grantor) || '|' || e.privilege_type || '|' || e.is_grantable::text AS line
                    FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) e) x
   WHERE d.datname = current_database()
)
SELECT json_build_object(
  'cluster', (SELECT system_identifier::text FROM pg_control_system()),
  'database', current_database()::text,
  'migration', CASE
      WHEN EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)
        THEN 'incomplete'
      ELSE (SELECT max(migration_name) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
    END,
  'migrationOwner', (SELECT name FROM owner),
  'ownerIsPrivileged', coalesce((SELECT (o.rolsuper OR o.rolbypassrls) AND o.name = current_user::text FROM owner o), false),
  'tenantTables', (SELECT count(*) FROM tenant),
  'disabledTables', (SELECT count(*) FROM tenant WHERE NOT relrowsecurity),
  'unforcedTables', (SELECT count(*) FROM tenant WHERE NOT relforcerowsecurity),
  'qrSchemaPresent', EXISTS (SELECT 1 FROM schemas WHERE nspname = 'swift_qr'),
  'qrUnsafeGrants', (SELECT count(*) FROM qr_grants WHERE grantee IN (SELECT oid FROM watched)),
  'obsoleteExecutable', (
    SELECT count(*) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     WHERE p.proname IN ('move_vendor_tenant', 'vendors_tenant_move_guard', 'qr_codes_credit_move_guard')
       AND x.privilege_type = 'EXECUTE' AND x.grantee IN (SELECT oid FROM watched)),
  'parentUpdateMissing', CASE WHEN NOT EXISTS (SELECT 1 FROM app) THEN 2 ELSE (
    SELECT count(*) FROM (VALUES ('public.vendors'), ('public.qr_codes')) AS t(rel)
     WHERE to_regclass(t.rel) IS NULL OR NOT has_table_privilege((SELECT oid FROM app), to_regclass(t.rel), 'UPDATE')) END,
  'appendOnlyUnsafeGrants', CASE WHEN NOT EXISTS (SELECT 1 FROM app) THEN 1 ELSE (
    (SELECT count(*) FROM revoked v
      WHERE to_regclass(v.rel) IS NOT NULL AND has_table_privilege((SELECT oid FROM app), to_regclass(v.rel), v.priv))
    + (SELECT count(*) FROM pg_class c JOIN schemas s ON s.oid = c.relnamespace,
              aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
        WHERE c.relkind IN ('r', 'p') AND x.privilege_type = 'TRUNCATE' AND x.grantee IN (SELECT oid FROM watched))) END,
  'defaultGrantCount', (
    SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) x
     WHERE x.grantee <> d.defaclrole
       AND NOT (x.grantee = (SELECT oid FROM app) AND d.defaclnamespace = (SELECT oid FROM schemas WHERE nspname = 'public') AND (
             (d.defaclobjtype = 'r' AND x.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
          OR (d.defaclobjtype = 'S' AND x.privilege_type IN ('USAGE', 'SELECT'))
          OR (d.defaclobjtype = 'f' AND x.privilege_type = 'EXECUTE')))
       AND NOT (x.grantee = 0 AND d.defaclobjtype IN ('f', 'T') AND x.privilege_type IN ('EXECUTE', 'USAGE'))),
  'groupUnsafeAttributes', (
    SELECT coalesce(sum(CASE WHEN g.oid IS NULL THEN 1 ELSE
             (g.rolcanlogin::int + g.rolsuper::int + g.rolbypassrls::int + g.rolcreatedb::int
              + g.rolcreaterole::int + g.rolreplication::int) END), 0)::int FROM grp g),
  'groupUnexpectedParents', (
    SELECT count(*) FROM pg_auth_members m WHERE m.member IN (SELECT oid FROM grp WHERE oid IS NOT NULL)),
  'groupOwnedObjects', (
    SELECT count(*) FROM pg_shdepend d
     WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o'
       AND d.refobjid IN (SELECT oid FROM grp WHERE oid IS NOT NULL)),
  'ownershipDigest', (SELECT encode(sha256(convert_to(coalesce(string_agg(line, E'\n' ORDER BY line COLLATE "C"), ''), 'UTF8')), 'hex') FROM ownership),
  'aclDigest', (SELECT encode(sha256(convert_to(coalesce(string_agg(line, E'\n' ORDER BY line COLLATE "C"), ''), 'UTF8')), 'hex') FROM acls),
  'roles', coalesce((
    SELECT json_object_agg(r.rolname, json_build_object(
      'login', r.rolcanlogin, 'inherit', r.rolinherit, 'superuser', r.rolsuper, 'bypassrls', r.rolbypassrls,
      'createdb', r.rolcreatedb, 'createrole', r.rolcreaterole, 'replication', r.rolreplication,
      'parents', coalesce((SELECT json_agg(p.rolname ORDER BY p.rolname)
                             FROM pg_auth_members m JOIN pg_roles p ON p.oid = m.roleid WHERE m.member = r.oid), '[]'::json),
      'reachable', coalesce((SELECT json_agg(p.rolname ORDER BY p.rolname)
                               FROM pg_roles p WHERE p.oid <> r.oid AND pg_has_role(r.oid, p.oid, 'MEMBER')), '[]'::json),
      'adminMemberships', (SELECT count(*) FROM pg_auth_members m WHERE (m.member = r.oid OR m.roleid = r.oid) AND m.admin_option),
      'ownedObjects', (SELECT count(*) FROM pg_shdepend d
                        WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'),
      'directGrants', (SELECT count(*) FROM pg_shdepend d
                        WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype IN ('a', 'r', 'i')),
      'settings', coalesce((SELECT json_agg(split_part(c.setting, '=', 1) ORDER BY split_part(c.setting, '=', 1))
                              FROM pg_db_role_setting rs, unnest(rs.setconfig) AS c(setting) WHERE rs.setrole = r.oid), '[]'::json),
      'memberCount', (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid)))
      FROM pg_roles r WHERE r.rolname IN ('swift_app_login', 'swift_system_login')), '{}'::json)
);
