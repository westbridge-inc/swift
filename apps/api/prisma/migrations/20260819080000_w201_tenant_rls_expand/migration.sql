-- [ELV-1 W-201 stage 1: EXPAND] RLS policies on all 51 tenant-bearing tables.
-- ENABLE (not FORCE): the app connects as table owner and is unaffected until
-- the deliberate CONTRACT stage. Predicate fails CLOSED without tenant context.

ALTER TABLE "EmergencyContact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "EmergencyContact";
CREATE POLICY "tenant_isolation" ON "EmergencyContact"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "EvidenceBundle" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "EvidenceBundle";
CREATE POLICY "tenant_isolation" ON "EvidenceBundle"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "IncidentCase" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "IncidentCase";
CREATE POLICY "tenant_isolation" ON "IncidentCase"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "LivenessCheck" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "LivenessCheck";
CREATE POLICY "tenant_isolation" ON "LivenessCheck"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "SafetyAccessLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "SafetyAccessLog";
CREATE POLICY "tenant_isolation" ON "SafetyAccessLog"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "SosAlert" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "SosAlert";
CREATE POLICY "tenant_isolation" ON "SosAlert"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "TripSafetySession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "TripSafetySession";
CREATE POLICY "tenant_isolation" ON "TripSafetySession"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "actor_rating_stats" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "actor_rating_stats";
CREATE POLICY "tenant_isolation" ON "actor_rating_stats"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_campaigns" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_campaigns";
CREATE POLICY "tenant_isolation" ON "ad_campaigns"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_events";
CREATE POLICY "tenant_isolation" ON "ad_events"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_invoices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_invoices";
CREATE POLICY "tenant_isolation" ON "ad_invoices"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_placements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_placements";
CREATE POLICY "tenant_isolation" ON "ad_placements"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_refund_intents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_refund_intents";
CREATE POLICY "tenant_isolation" ON "ad_refund_intents"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_refund_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_refund_items";
CREATE POLICY "tenant_isolation" ON "ad_refund_items"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ad_refund_outbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_refund_outbox";
CREATE POLICY "tenant_isolation" ON "ad_refund_outbox"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ads_audit_log" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ads_audit_log";
CREATE POLICY "tenant_isolation" ON "ads_audit_log"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ads_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ads_settings";
CREATE POLICY "tenant_isolation" ON "ads_settings"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "advertisers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "advertisers";
CREATE POLICY "tenant_isolation" ON "advertisers"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "attribution_claims" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "attribution_claims";
CREATE POLICY "tenant_isolation" ON "attribution_claims"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "batch_evaluations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "batch_evaluations";
CREATE POLICY "tenant_isolation" ON "batch_evaluations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "batching_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "batching_settings";
CREATE POLICY "tenant_isolation" ON "batching_settings"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "booking_exceptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "booking_exceptions";
CREATE POLICY "tenant_isolation" ON "booking_exceptions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "delivery_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "delivery_runs";
CREATE POLICY "tenant_isolation" ON "delivery_runs"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "discovery_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "discovery_categories";
CREATE POLICY "tenant_isolation" ON "discovery_categories"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "discovery_category_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "discovery_category_requests";
CREATE POLICY "tenant_isolation" ON "discovery_category_requests"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "discovery_category_suggestions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "discovery_category_suggestions";
CREATE POLICY "tenant_isolation" ON "discovery_category_suggestions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "fee_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "fee_receipts";
CREATE POLICY "tenant_isolation" ON "fee_receipts"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "house_ads" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "house_ads";
CREATE POLICY "tenant_isolation" ON "house_ads"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "identity_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "identity_keys";
CREATE POLICY "tenant_isolation" ON "identity_keys"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "item_discovery_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "item_discovery_categories";
CREATE POLICY "tenant_isolation" ON "item_discovery_categories"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "item_feedbacks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "item_feedbacks";
CREATE POLICY "tenant_isolation" ON "item_feedbacks"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "mmg_agent_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mmg_agent_payments";
CREATE POLICY "tenant_isolation" ON "mmg_agent_payments"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "orders";
CREATE POLICY "tenant_isolation" ON "orders"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "pending_attributions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pending_attributions";
CREATE POLICY "tenant_isolation" ON "pending_attributions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "qr_codes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "qr_codes";
CREATE POLICY "tenant_isolation" ON "qr_codes"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "rating_reports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rating_reports";
CREATE POLICY "tenant_isolation" ON "rating_reports"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "rating_tag_defs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rating_tag_defs";
CREATE POLICY "tenant_isolation" ON "rating_tag_defs"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "receipt_counters" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "receipt_counters";
CREATE POLICY "tenant_isolation" ON "receipt_counters"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "ride_queue_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ride_queue_entries";
CREATE POLICY "tenant_isolation" ON "ride_queue_entries"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "san_tombstones" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "san_tombstones";
CREATE POLICY "tenant_isolation" ON "san_tombstones"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "scan_daily_rollups" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "scan_daily_rollups";
CREATE POLICY "tenant_isolation" ON "scan_daily_rollups"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "scan_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "scan_events";
CREATE POLICY "tenant_isolation" ON "scan_events"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "settlement_batches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "settlement_batches";
CREATE POLICY "tenant_isolation" ON "settlement_batches"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "slug_redirects" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "slug_redirects";
CREATE POLICY "tenant_isolation" ON "slug_redirects"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "supply_watches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "supply_watches";
CREATE POLICY "tenant_isolation" ON "supply_watches"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "tenant_billing_currency" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tenant_billing_currency";
CREATE POLICY "tenant_isolation" ON "tenant_billing_currency"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "trial_grants" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "trial_grants";
CREATE POLICY "tenant_isolation" ON "trial_grants"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "trip_share_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "trip_share_tokens";
CREATE POLICY "tenant_isolation" ON "trip_share_tokens"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "users";
CREATE POLICY "tenant_isolation" ON "users"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "vendor_discovery_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_discovery_categories";
CREATE POLICY "tenant_isolation" ON "vendor_discovery_categories"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendors";
CREATE POLICY "tenant_isolation" ON "vendors"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on'));
