-- [REPORT-086 · PR1197-S1-04] A QR CODE, ITS STOREFRONT, AND EVERY ROW THAT
-- CREDITS A SCAN OF IT BELONG TO ONE TENANT.
--
-- WHY. `qr_codes` and `slug_redirects` address their target polymorphically —
-- (entityType, entityId) — with no relation and nothing binding that pair to a
-- Vendor in the SAME tenant. The public resolver is deliberately unauthenticated
-- (a printed code names its own tenant), so nothing anywhere required the two to
-- agree. A malformed or migrated row could pair tenant A's QR code with tenant
-- B's storefront, and AttributionService persists that pairing: tenant A takes
-- the credit for a scan that sent a customer to tenant B's shop.
--
-- The runtime read is repaired separately (qr.service.ts binds id + tenantId and
-- validates entityType), so a corrupt legacy row resolves UNAVAILABLE rather than
-- disclosing the foreign vendor. This migration closes the storage boundary.
--
-- WHY THIS SHAPE. An earlier draft of this migration hand-rolled its own trigger
-- function. That was wrong twice over: this repository already has the exact
-- mechanism — `TENANT_LINEAGE_TABLES` + `tenantLineageDdl()` in
-- `src/lib/tenant-rls.ts`, 24 tables, mirrored by the test installer so a
-- db-push environment heals itself — and a second, divergent implementation of
-- "this row's tenant must equal its parent's" is how two rules drift apart. The
-- five rules below are registered there and this file is generated from it.
--
-- WHAT THE EARLIER DRAFT ALSO MISSED: it guarded `qr_codes` and `slug_redirects`
-- only. The harm it describes — the CREDIT going to the wrong tenant — is
-- recorded in `pending_attributions`, `attribution_claims` and `scan_events`,
-- all of which accepted a cross-tenant row. All five are covered here.
--
-- `entityType` is watched but not interpreted: these rules resolve `entityId` in
-- `vendors`, so a row declaring any other entity type finds no parent and is
-- REFUSED. That is correct today (VENDOR is the enum's only value) and it is
-- deliberately NOT future-proof — a second entity type must add its own rule.
--
-- CENSUS BEFORE WRITING THIS (2026-09-07, local databases):
--   swift_test: qr_total=14  qr_orphan=14  redirect_total=0  redirect_orphan=0
--   swift:      qr_total=4   qr_orphan=0   redirect_total=0  redirect_orphan=0
-- Every orphan is a row whose VENDOR WAS DELETED (test cleanup), not a
-- cross-tenant pairing. The lineage trigger fires BEFORE INSERT OR UPDATE and
-- returns NEW when an UPDATE finds no parent, so historical residue is left
-- exactly as it is while no new corruption can be written.
--
-- ROLLBACK (per table T and trigger G, all five):
--   DROP TRIGGER IF EXISTS G ON T; DROP FUNCTION IF EXISTS G();
-- Safe at any time: it removes enforcement, never data.

-- Remove the hand-rolled draft, if a database already received it.
DROP TRIGGER IF EXISTS qr_codes_tenant_lineage ON "qr_codes";
DROP TRIGGER IF EXISTS slug_redirects_tenant_lineage ON "slug_redirects";
DROP FUNCTION IF EXISTS assert_qr_target_tenant();

CREATE OR REPLACE FUNCTION qr_codes_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM vendors WHERE id = NEW."entityId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
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
        SELECT "tenantId" FROM vendors WHERE id = NEW."entityId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
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
        SELECT "tenantId" FROM qr_codes WHERE id = NEW."qrCodeId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
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
        SELECT CASE WHEN NEW."qrCodeId" IS NULL THEN NEW."tenantId" ELSE (SELECT "tenantId" FROM qr_codes WHERE id = NEW."qrCodeId") END INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
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
        SELECT CASE WHEN NEW."qrCodeId" IS NULL THEN NEW."tenantId" ELSE (SELECT "tenantId" FROM qr_codes WHERE id = NEW."qrCodeId") END INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
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
