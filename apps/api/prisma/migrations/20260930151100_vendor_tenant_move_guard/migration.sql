-- Final-state parent guards; no caller-writable bypass setting.
-- QR-only moves carry printed codes and scan/attribution/rollup credit.
-- Store/menu/order/financial dependencies require a separate reviewed move;
-- this routine refuses them without changing their tenancy.
-- Guard functions read all dependencies with migration-owner authority;
-- deployment must use the trusted migration role. Move remains invoker-only.
BEGIN;
CREATE OR REPLACE FUNCTION vendors_tenant_move_guard() RETURNS trigger AS $$
      DECLARE final_tenant TEXT; stranded BIGINT;
      BEGIN
        IF NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN RETURN NULL; END IF;
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'vendor tenant moves require READ COMMITTED isolation [STA-1 lineage]' USING ERRCODE = 'check_violation';
        END IF;
        LOCK TABLE public.booking_exceptions, public.categories, public.delivery_cash_settlements, public.discovery_category_requests, public.items, public.mmg_refund_obligations, public.mmg_refund_sends, public.orders, public.settlements, public.vendor_discovery_categories, public.vendor_prep_stats IN SHARE MODE;
        SELECT "tenantId" INTO final_tenant FROM public.vendors WHERE id = NEW.id;
        IF final_tenant IS NULL THEN RETURN NULL; END IF; -- parent deleted in the same transaction
        SELECT (SELECT count(*) FROM public.qr_codes WHERE "entityType" = 'VENDOR' AND "entityId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.slug_redirects WHERE "entityType" = 'VENDOR' AND "entityId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.booking_exceptions WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.categories WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.delivery_cash_settlements WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.discovery_category_requests WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.items WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.mmg_refund_obligations WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.mmg_refund_sends WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.orders WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.settlements WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.vendor_discovery_categories WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.vendor_prep_stats WHERE "vendorId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) INTO stranded;
        IF stranded > 0 THEN
          RAISE EXCEPTION 'vendor % cannot change tenant while % lineage row(s) remain in another tenant [PR1197-S1-04]',
            NEW.id, stranded USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS vendors_tenant_move_guard ON vendors;

CREATE CONSTRAINT TRIGGER vendors_tenant_move_guard AFTER UPDATE OF "tenantId" ON vendors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vendors_tenant_move_guard();

CREATE OR REPLACE FUNCTION qr_codes_credit_move_guard() RETURNS trigger AS $$
      DECLARE final_tenant TEXT; final_vendor TEXT; stranded BIGINT;
      BEGIN
        IF NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" AND NEW."entityId" IS NOT DISTINCT FROM OLD."entityId" AND NEW."entityType" IS NOT DISTINCT FROM OLD."entityType" THEN RETURN NULL; END IF;
        IF NEW."entityId" IS DISTINCT FROM OLD."entityId" OR NEW."entityType" IS DISTINCT FROM OLD."entityType" THEN
          RAISE EXCEPTION 'printed QR target is immutable [STA-1 lineage]' USING ERRCODE = 'check_violation';
        END IF;
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'QR tenant/target moves require READ COMMITTED isolation [STA-1 lineage]' USING ERRCODE = 'check_violation';
        END IF;
        SELECT "tenantId", "entityId" INTO final_tenant, final_vendor FROM public.qr_codes WHERE id = NEW.id;
        IF final_tenant IS NULL THEN RETURN NULL; END IF;
        SELECT (SELECT count(*) FROM public.pending_attributions WHERE "qrCodeId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.attribution_claims WHERE "qrCodeId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.scan_events WHERE "qrCodeId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant) + (SELECT count(*) FROM public.scan_daily_rollups WHERE "qrCodeId" = NEW.id AND "tenantId" IS DISTINCT FROM final_tenant)
          + (SELECT count(*) FROM public.orders WHERE "attributionQrCodeId" = NEW.id AND ("tenantId" IS DISTINCT FROM final_tenant OR "vendorId" IS DISTINCT FROM final_vendor)) INTO stranded;
        IF stranded > 0 THEN
          RAISE EXCEPTION 'QR % cannot change its target while % credit lineage row(s) would be stranded [STA-1 lineage]', NEW.id, stranded USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS qr_codes_credit_move_guard ON qr_codes;

CREATE CONSTRAINT TRIGGER qr_codes_credit_move_guard AFTER UPDATE OF "tenantId", "entityId", "entityType" ON qr_codes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qr_codes_credit_move_guard();

CREATE OR REPLACE FUNCTION move_vendor_tenant(p_vendor_id TEXT, p_new_tenant TEXT) RETURNS void AS $$
      DECLARE old_tenant TEXT; dependencies BIGINT;
      BEGIN
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'vendor tenant moves require READ COMMITTED isolation [STA-1 lineage]' USING ERRCODE = 'check_violation';
        END IF;
        -- Serialize even dependencies without a vendor FK before the census.
        -- Lock tables before the vendor to avoid a needless lock inversion.
        LOCK TABLE public.booking_exceptions, public.categories, public.delivery_cash_settlements, public.discovery_category_requests, public.items, public.mmg_refund_obligations, public.mmg_refund_sends, public.orders, public.settlements, public.vendor_discovery_categories, public.vendor_prep_stats IN SHARE MODE;
        -- Lock BEFORE the census; a concurrent QR writer holds FOR SHARE.
        SELECT "tenantId" INTO old_tenant FROM public.vendors WHERE id = p_vendor_id FOR UPDATE;
        IF old_tenant IS NULL THEN
          RAISE EXCEPTION 'vendor % does not exist or is not visible', p_vendor_id USING ERRCODE = 'check_violation';
        END IF;
        IF old_tenant = p_new_tenant THEN RETURN; END IF;
        IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_new_tenant) THEN
          RAISE EXCEPTION 'target tenant does not exist' USING ERRCODE = 'check_violation';
        END IF;
        SELECT (SELECT count(*) FROM public.booking_exceptions WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.categories WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.delivery_cash_settlements WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.discovery_category_requests WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.items WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.mmg_refund_obligations WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.mmg_refund_sends WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.orders WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.settlements WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.vendor_discovery_categories WHERE "vendorId" = p_vendor_id) + (SELECT count(*) FROM public.vendor_prep_stats WHERE "vendorId" = p_vendor_id) INTO dependencies;
        IF dependencies > 0 THEN
          RAISE EXCEPTION 'vendor % has non-QR dependencies; QR-only tenant move refused [PR1197-S1-04]', p_vendor_id USING ERRCODE = 'check_violation';
        END IF;
        UPDATE public.vendors SET "tenantId" = p_new_tenant WHERE id = p_vendor_id;
        UPDATE public.qr_codes SET "tenantId" = p_new_tenant WHERE "entityType" = 'VENDOR' AND "entityId" = p_vendor_id AND "tenantId" = old_tenant;
        UPDATE public.slug_redirects SET "tenantId" = p_new_tenant WHERE "entityType" = 'VENDOR' AND "entityId" = p_vendor_id AND "tenantId" = old_tenant;
        UPDATE public.pending_attributions c SET "tenantId" = p_new_tenant FROM public.qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        UPDATE public.attribution_claims c SET "tenantId" = p_new_tenant FROM public.qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        UPDATE public.scan_events c SET "tenantId" = p_new_tenant FROM public.qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        UPDATE public.scan_daily_rollups c SET "tenantId" = p_new_tenant FROM public.qr_codes q WHERE q.id = c."qrCodeId" AND q."entityType" = 'VENDOR' AND q."entityId" = p_vendor_id AND c."tenantId" = old_tenant;
        -- Deferred constraints are checked at commit. No session flag permits
        -- skipping them, and a financial/order dependency aborts the move.
      END $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp;
COMMIT;
