-- [PR1197-S1-04] A parent may not walk away from its lineage.
--
-- The lineage triggers watch the CHILD. Nothing watched the PARENT, so one
-- `UPDATE vendors SET "tenantId"` created the cross-tenant pairing the lineage
-- migration says it prevents — and stranded every already-PRINTED QR code in
-- the tenant the vendor had left, resolving each scan to /qr/unavailable
-- permanently. Generated from vendorTenantMoveDdl(); qr-tenant-lineage.test.ts
-- fails if this file stops matching the generator.
CREATE OR REPLACE FUNCTION vendors_tenant_move_guard() RETURNS trigger AS $$
      DECLARE stranded BIGINT;
      BEGIN
        IF NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN RETURN NEW; END IF;
        -- The supported move sets this to the vendor it is moving, for this
        -- transaction only. Any other id (or none) is an unaccompanied move.
        IF coalesce(current_setting('app.vendor_tenant_move', true), '') = NEW.id THEN RETURN NEW; END IF;
        SELECT (SELECT count(*) FROM qr_codes WHERE "entityType" = 'VENDOR' AND "entityId" = NEW.id AND "tenantId" = OLD."tenantId") + (SELECT count(*) FROM slug_redirects WHERE "entityType" = 'VENDOR' AND "entityId" = NEW.id AND "tenantId" = OLD."tenantId")
          INTO stranded;
        IF stranded > 0 THEN
          RAISE EXCEPTION 'vendor % cannot change tenant while % lineage row(s) remain in tenant %: every printed QR code would resolve to nothing. Use move_vendor_tenant(%, %) which moves them together [PR1197-S1-04]',
            NEW.id, stranded, OLD."tenantId", quote_literal(NEW.id), quote_literal(NEW."tenantId") USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendors_tenant_move_guard ON vendors;

CREATE TRIGGER vendors_tenant_move_guard BEFORE UPDATE OF "tenantId" ON vendors FOR EACH ROW EXECUTE FUNCTION vendors_tenant_move_guard();

CREATE OR REPLACE FUNCTION move_vendor_tenant(p_vendor_id TEXT, p_new_tenant TEXT) RETURNS void AS $$
      DECLARE old_tenant TEXT;
      BEGIN
        SELECT "tenantId" INTO old_tenant FROM vendors WHERE id = p_vendor_id;
        IF old_tenant IS NULL THEN
          RAISE EXCEPTION 'vendor % does not exist', p_vendor_id USING ERRCODE = 'check_violation';
        END IF;
        IF old_tenant = p_new_tenant THEN RETURN; END IF;
        PERFORM set_config('app.vendor_tenant_move', p_vendor_id, true);
        -- The parent first: each child's own lineage trigger then checks
        -- against a parent that has already arrived, so every re-stamp is
        -- validated by the same rule that would refuse a wrong one.
        UPDATE vendors SET "tenantId" = p_new_tenant WHERE id = p_vendor_id;
        UPDATE qr_codes SET "tenantId" = p_new_tenant WHERE "entityType" = 'VENDOR' AND "entityId" = p_vendor_id AND "tenantId" = old_tenant;
        UPDATE slug_redirects SET "tenantId" = p_new_tenant WHERE "entityType" = 'VENDOR' AND "entityId" = p_vendor_id AND "tenantId" = old_tenant;
        UPDATE pending_attributions c SET "tenantId" = p_new_tenant FROM qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        UPDATE attribution_claims c SET "tenantId" = p_new_tenant FROM qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        UPDATE scan_events c SET "tenantId" = p_new_tenant FROM qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        PERFORM set_config('app.vendor_tenant_move', '', true);
      END $$ LANGUAGE plpgsql;

