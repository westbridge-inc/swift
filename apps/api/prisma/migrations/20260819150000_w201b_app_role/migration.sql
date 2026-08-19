-- [ELV-1 W-201b] The future app role: NOBYPASSRLS, non-owner — RLS binds it
-- from ENABLE alone. NOLOGIN here (no credentials in a public repo);
-- deploy-time provisioning adds LOGIN + password out-of-band. Grants cover
-- everything the app does today, and DEFAULT PRIVILEGES make every FUTURE
-- table/sequence auto-granted — the classic contract-day failure (a new
-- table nobody granted) is closed in advance.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_app') THEN
    CREATE ROLE swift_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO swift_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO swift_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swift_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO swift_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO swift_app;
