-- [REPORT-086 · PR1197-S1-04] A QR CODE AND ITS TARGET MUST LIVE IN ONE TENANT.
--
-- WHY. `qr_codes` and `slug_redirects` address their target polymorphically —
-- (entityType, entityId) — with no relation, no foreign key and no constraint
-- binding that pair to a Vendor in the SAME tenant. The public resolver is
-- deliberately unauthenticated (a printed code names its own tenant), so
-- nothing anywhere required the two to agree. A malformed, migrated or
-- hand-written row could therefore pair tenant A's QR code with tenant B's
-- storefront, and AttributionService persists that pairing: tenant A takes the
-- credit for a scan that sent someone to tenant B's shop.
--
-- The runtime read is repaired separately (qr.service.ts binds id + tenantId
-- and validates entityType), so a corrupt legacy row now resolves UNAVAILABLE
-- rather than disclosing the foreign vendor. This migration closes the storage
-- boundary so no NEW corrupt row can be written at all.
--
-- WHY A TRIGGER AND NOT A FOREIGN KEY. The address is polymorphic. A composite
-- FK to `vendors(id, tenantId)` would work only while VENDOR is the enum's one
-- value, and would have to be dropped the day a second entity type is added —
-- exactly when the guarantee matters most. A constraint trigger expresses the
-- real rule and survives the second value.
--
-- CENSUS BEFORE WRITING THIS (2026-09-07, local databases):
--   swift_test: qr_total=14  qr_orphan=14  redirect_total=0  redirect_orphan=0
--   swift:      qr_total=4   qr_orphan=0   redirect_total=0  redirect_orphan=0
-- Every orphan is a row whose VENDOR WAS DELETED (test cleanup), not a
-- cross-tenant pairing. The trigger therefore fires on INSERT and UPDATE ONLY:
-- it makes new corruption impossible without failing on historical rows, which
-- the repaired resolver already renders unavailable. Deliberately NOT a
-- validated CHECK over existing data — that would fail the deploy on residue
-- that is already handled, and a migration that cannot run is not a control.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS qr_codes_tenant_lineage ON "qr_codes";
--   DROP TRIGGER IF EXISTS slug_redirects_tenant_lineage ON "slug_redirects";
--   DROP FUNCTION IF EXISTS assert_qr_target_tenant();
-- Safe at any time: it removes an enforcement, never data.

CREATE OR REPLACE FUNCTION assert_qr_target_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW."entityType" = 'VENDOR' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "vendors" v
      WHERE v."id" = NEW."entityId" AND v."tenantId" = NEW."tenantId"
    ) THEN
      RAISE EXCEPTION
        'qr_target_tenant_mismatch: % row addresses entityId % which is not a VENDOR in tenant %',
        TG_TABLE_NAME, NEW."entityId", NEW."tenantId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION
      'qr_target_entity_type_unsupported: % row declares entityType %, which has no target table',
      TG_TABLE_NAME, NEW."entityType"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qr_codes_tenant_lineage ON "qr_codes";
CREATE CONSTRAINT TRIGGER qr_codes_tenant_lineage
  AFTER INSERT OR UPDATE OF "entityId", "tenantId", "entityType" ON "qr_codes"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_qr_target_tenant();

DROP TRIGGER IF EXISTS slug_redirects_tenant_lineage ON "slug_redirects";
CREATE CONSTRAINT TRIGGER slug_redirects_tenant_lineage
  AFTER INSERT OR UPDATE OF "entityId", "tenantId", "entityType" ON "slug_redirects"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_qr_target_tenant();
