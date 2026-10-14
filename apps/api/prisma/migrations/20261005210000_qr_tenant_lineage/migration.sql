-- [row 106 · #1217] QR target and credit lineage. Generated from tenantLineageDdl()
-- (apps/api/src/lib/tenant-rls.ts, the rules with requiredParent).
-- Existing printed ACTIVE codes are preserved; no rows are restamped.
-- Nullable claim/scan/order links remain valid. Non-null missing or hidden
-- parents are refused on INSERT and UPDATE. QR parents are locked FOR SHARE
-- until commit. Run the read-only preflight before deployment; legacy
-- violations are not repaired by this migration and public reads fail closed.
-- (Slot 20261005210000, reserved for L05; formerly 20260930151000, never applied.)
BEGIN;
DROP TRIGGER IF EXISTS qr_codes_tenant_lineage ON qr_codes;
DROP TRIGGER IF EXISTS slug_redirects_tenant_lineage ON slug_redirects;
DROP FUNCTION IF EXISTS assert_qr_target_tenant();
CREATE OR REPLACE FUNCTION qr_codes_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM public.vendors WHERE id = NEW."entityId" AND NEW."entityType" = 'VENDOR' FOR SHARE INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'qr_codes row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."entityId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'qr_codes row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."entityId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qr_codes_tenant_matches_vendor ON qr_codes;

CREATE TRIGGER qr_codes_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "entityId", "entityType" ON qr_codes FOR EACH ROW EXECUTE FUNCTION qr_codes_tenant_matches_vendor();

CREATE OR REPLACE FUNCTION slug_redirects_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM public.vendors WHERE id = NEW."entityId" AND NEW."entityType" = 'VENDOR' FOR SHARE INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'slug_redirects row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."entityId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'slug_redirects row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."entityId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS slug_redirects_tenant_matches_vendor ON slug_redirects;

CREATE TRIGGER slug_redirects_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "entityId", "entityType" ON slug_redirects FOR EACH ROW EXECUTE FUNCTION slug_redirects_tenant_matches_vendor();

CREATE OR REPLACE FUNCTION pending_attributions_tenant_matches_code() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM public.qr_codes WHERE id = NEW."qrCodeId" FOR SHARE INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'pending_attributions row % names qr_codes row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."qrCodeId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'pending_attributions row % names tenant % but its qr_codes row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."qrCodeId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_attributions_tenant_matches_code ON pending_attributions;

CREATE TRIGGER pending_attributions_tenant_matches_code BEFORE INSERT OR UPDATE OF "tenantId", "qrCodeId" ON pending_attributions FOR EACH ROW EXECUTE FUNCTION pending_attributions_tenant_matches_code();

CREATE OR REPLACE FUNCTION attribution_claims_tenant_matches_code() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT CASE WHEN NEW."qrCodeId" IS NULL THEN NEW."tenantId" ELSE (SELECT "tenantId" FROM public.qr_codes WHERE id = NEW."qrCodeId" FOR SHARE) END INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'attribution_claims row % names qr_codes row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."qrCodeId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'attribution_claims row % names tenant % but its qr_codes row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."qrCodeId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attribution_claims_tenant_matches_code ON attribution_claims;

CREATE TRIGGER attribution_claims_tenant_matches_code BEFORE INSERT OR UPDATE OF "tenantId", "qrCodeId" ON attribution_claims FOR EACH ROW EXECUTE FUNCTION attribution_claims_tenant_matches_code();

CREATE OR REPLACE FUNCTION scan_events_tenant_matches_code() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT CASE WHEN NEW."qrCodeId" IS NULL THEN NEW."tenantId" ELSE (SELECT "tenantId" FROM public.qr_codes WHERE id = NEW."qrCodeId" FOR SHARE) END INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'scan_events row % names qr_codes row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."qrCodeId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'scan_events row % names tenant % but its qr_codes row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."qrCodeId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scan_events_tenant_matches_code ON scan_events;

CREATE TRIGGER scan_events_tenant_matches_code BEFORE INSERT OR UPDATE OF "tenantId", "qrCodeId" ON scan_events FOR EACH ROW EXECUTE FUNCTION scan_events_tenant_matches_code();

CREATE OR REPLACE FUNCTION scan_daily_rollups_tenant_matches_code() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM public.qr_codes WHERE id = NEW."qrCodeId" FOR SHARE INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'scan_daily_rollups row % names qr_codes row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."qrCodeId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'scan_daily_rollups row % names tenant % but its qr_codes row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."qrCodeId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scan_daily_rollups_tenant_matches_code ON scan_daily_rollups;

CREATE TRIGGER scan_daily_rollups_tenant_matches_code BEFORE INSERT OR UPDATE OF "tenantId", "qrCodeId" ON scan_daily_rollups FOR EACH ROW EXECUTE FUNCTION scan_daily_rollups_tenant_matches_code();

CREATE OR REPLACE FUNCTION orders_tenant_matches_attribution_code() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT CASE WHEN NEW."attributionQrCodeId" IS NULL THEN NEW."tenantId" ELSE (SELECT "tenantId" FROM public.qr_codes WHERE id = NEW."attributionQrCodeId" AND "entityType" = 'VENDOR' AND "entityId" = NEW."vendorId" FOR SHARE) END INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'orders row % names qr_codes row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."attributionQrCodeId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'orders row % names tenant % but its qr_codes row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."attributionQrCodeId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_tenant_matches_attribution_code ON orders;

CREATE TRIGGER orders_tenant_matches_attribution_code BEFORE INSERT OR UPDATE OF "tenantId", "attributionQrCodeId", "vendorId" ON orders FOR EACH ROW EXECUTE FUNCTION orders_tenant_matches_attribution_code();

COMMIT;
