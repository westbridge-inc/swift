-- [STA-1 DL-4] isSynthetic is a fact of the tenant, held by the database.
--
-- DL-4 excludes the review fiction from every aggregate by Tenant.kind AND
-- Actor.isSynthetic — belt and braces. The braces are only as good as the
-- belt if the flag can never disagree with the tenant: a row in a REVIEW or
-- CRAWLER tenant IS synthetic (derived on write; the default `false` means
-- "unstamped"), and a row in a PRODUCTION tenant can never be marked
-- synthetic (refused). A seed that forgets the flag, or a production row that
-- borrows it, cannot lie to lib/production-only.ts.
--
-- Truth first: any existing fiction rows without the flag are corrected.
UPDATE "users" u SET "isSynthetic" = true FROM "tenants" t WHERE t.id = u."tenantId" AND t.kind <> 'PRODUCTION' AND u."isSynthetic" = false;
UPDATE "vendors" v SET "isSynthetic" = true FROM "tenants" t WHERE t.id = v."tenantId" AND t.kind <> 'PRODUCTION' AND v."isSynthetic" = false;

-- Text mirrored by syntheticDerivationDdl() in src/lib/tenant-rls.ts.
CREATE OR REPLACE FUNCTION users_synthetic_matches_tenant() RETURNS trigger AS $$
      DECLARE tenant_kind TEXT;
      BEGIN
        SELECT kind::text INTO tenant_kind FROM tenants WHERE id = NEW."tenantId";
        IF tenant_kind IS NULL THEN RETURN NEW; END IF; -- the FK, not this trigger, judges a missing tenant
        IF tenant_kind <> 'PRODUCTION' THEN
          NEW."isSynthetic" := true;
        ELSIF NEW."isSynthetic" THEN
          RAISE EXCEPTION 'users row % is in PRODUCTION tenant % and cannot be synthetic [STA-1 DL-4]', NEW.id, NEW."tenantId"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_synthetic_matches_tenant ON users;
CREATE TRIGGER users_synthetic_matches_tenant BEFORE INSERT OR UPDATE OF "isSynthetic", "tenantId" ON users FOR EACH ROW EXECUTE FUNCTION users_synthetic_matches_tenant();
CREATE OR REPLACE FUNCTION vendors_synthetic_matches_tenant() RETURNS trigger AS $$
      DECLARE tenant_kind TEXT;
      BEGIN
        SELECT kind::text INTO tenant_kind FROM tenants WHERE id = NEW."tenantId";
        IF tenant_kind IS NULL THEN RETURN NEW; END IF; -- the FK, not this trigger, judges a missing tenant
        IF tenant_kind <> 'PRODUCTION' THEN
          NEW."isSynthetic" := true;
        ELSIF NEW."isSynthetic" THEN
          RAISE EXCEPTION 'vendors row % is in PRODUCTION tenant % and cannot be synthetic [STA-1 DL-4]', NEW.id, NEW."tenantId"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vendors_synthetic_matches_tenant ON vendors;
CREATE TRIGGER vendors_synthetic_matches_tenant BEFORE INSERT OR UPDATE OF "isSynthetic", "tenantId" ON vendors FOR EACH ROW EXECUTE FUNCTION vendors_synthetic_matches_tenant();
