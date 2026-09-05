-- [STA-1 Parts 3-4] The review tenant exists and is walled.
--
-- Store reviewers get a fiction: a REVIEW tenant whose vendors, riders,
-- customers and orders are invented (DL-3), isolated by Row-Level Security
-- rather than an `if` (DL-2), excluded from every aggregate by Tenant.kind and
-- Actor.isSynthetic (DL-4), and protected from the go-live purge (DL-8).
--
-- Reconciled to this repo (spec Part 3 says: follow the repo's convention):
--   * the session GUC stays `app.current_tenant` (52 tables already bind it),
--     not `app.current_tenant_id`;
--   * Tenant keeps `name` / `config`; no `displayName` / `countryCode` column
--     is added to a table that already has rows;
--   * ReviewCredential stores `staticOtpHash`, never the code itself.
--
-- Expand only. No row changes; every new column has a default that describes
-- the rows that exist (every tenant today is PRODUCTION, nobody is synthetic).

-- CreateEnum
CREATE TYPE "TenantKind" AS ENUM ('PRODUCTION', 'REVIEW', 'CRAWLER');

-- CreateEnum
CREATE TYPE "ReviewSessionStatus" AS ENUM ('PROVISIONED', 'ANCHORED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FixtureKind" AS ENUM ('VENDOR', 'RIDER_HOME', 'DRIVER_HOME', 'CUSTOMER_ADDRESS', 'POI');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "kind" "TenantKind" NOT NULL DEFAULT 'PRODUCTION',
ADD COLUMN     "purgeProtected" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isSynthetic" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "isSynthetic" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "review_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "ReviewSessionStatus" NOT NULL DEFAULT 'PROVISIONED',
    "anchorLat" DOUBLE PRECISION,
    "anchorLng" DOUBLE PRECISION,
    "anchorSource" TEXT,
    "anchoredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "review_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_credentials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "staticOtpHash" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_fixtures" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "FixtureKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "offsetLat" DOUBLE PRECISION NOT NULL,
    "offsetLng" DOUBLE PRECISION NOT NULL,
    "payload" JSONB,

    CONSTRAINT "review_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_sessions_tenantId_status_idx" ON "review_sessions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "review_sessions_expiresAt_idx" ON "review_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_credentials_tenantId_identifier_key" ON "review_credentials"("tenantId", "identifier");

-- CreateIndex
CREATE INDEX "review_fixtures_tenantId_kind_idx" ON "review_fixtures"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "tenants_kind_idx" ON "tenants"("kind");

-- CreateIndex
CREATE INDEX "users_isSynthetic_idx" ON "users"("isSynthetic");

-- CreateIndex
CREATE INDEX "vendors_isSynthetic_idx" ON "vendors"("isSynthetic");

-- AddForeignKey
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_credentials" ADD CONSTRAINT "review_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_fixtures" ADD CONSTRAINT "review_fixtures_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The fiction is walled like every other tenant's rows (Part 4.2).

ALTER TABLE "review_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "review_sessions";
CREATE POLICY "tenant_isolation" ON "review_sessions"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "review_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_credentials" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "review_credentials";
CREATE POLICY "tenant_isolation" ON "review_credentials"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "review_fixtures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_fixtures" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "review_fixtures";
CREATE POLICY "tenant_isolation" ON "review_fixtures"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- [STA-1 4.2] FORCE ROW LEVEL SECURITY on every walled table. Without it the
-- table OWNER bypasses the policy — exactly the role the app becomes when
-- pooling is misconfigured. (A superuser still bypasses: Postgres law, and the
-- reason the deploy role must never be one; rls-attestation reports it.)
ALTER TABLE "EmergencyContact" FORCE ROW LEVEL SECURITY;
ALTER TABLE "EvidenceBundle" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IncidentCase" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LivenessCheck" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SafetyAccessLog" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SosAlert" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TripSafetySession" FORCE ROW LEVEL SECURITY;
ALTER TABLE "actor_rating_stats" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sos_escalations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "money_surface_commands" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rating_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "privileged_approvals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sensitive_read_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sos_retriggers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "guardian_checkin_deliveries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "legal_holds" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ops_alerts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ops_alert_recipients" FORCE ROW LEVEL SECURITY;
ALTER TABLE "algo_config" FORCE ROW LEVEL SECURITY;
ALTER TABLE "algo_decisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vendor_prep_stats" FORCE ROW LEVEL SECURITY;
ALTER TABLE "eta_pad_stats" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_campaigns" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_invoices" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_placements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_refund_intents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_refund_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ad_refund_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ads_audit_log" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ads_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "advertisers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attribution_claims" FORCE ROW LEVEL SECURITY;
ALTER TABLE "batch_evaluations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "batching_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "booking_exceptions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "checkout_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "delivery_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deposit_confirmations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "discovery_categories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "discovery_category_requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE "discovery_category_suggestions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "fee_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "house_ads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "identity_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "item_discovery_categories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "item_feedbacks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "mmg_agent_payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "order_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pending_attributions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "provider_payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "qr_codes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rating_reports" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rating_tag_defs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "receipt_counters" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ride_queue_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "safety_deletion_holds" FORCE ROW LEVEL SECURITY;
ALTER TABLE "san_tombstones" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scan_daily_rollups" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scan_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "service_jobs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "settlement_batches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "settlement_imports" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slug_redirects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "storage_orphans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "supply_watches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_billing_currency" FORCE ROW LEVEL SECURITY;
ALTER TABLE "topup_commands" FORCE ROW LEVEL SECURITY;
ALTER TABLE "trial_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "trip_share_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "zones" FORCE ROW LEVEL SECURITY;
ALTER TABLE "user_blocks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vendor_discovery_categories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vendors" FORCE ROW LEVEL SECURITY;

-- [STA-1 DL-8] A purge-protected tenant cannot be DELETEd — not by the go-live
-- purge, not by a bulk cleanup, not by a cascading mistake. Clearing the flag
-- is its own deliberate statement; the trigger refuses everything else.
-- Text mirrored by tenantPurgeGuardDdl() in src/lib/tenant-rls.ts.
CREATE OR REPLACE FUNCTION tenants_purge_guard() RETURNS trigger AS $$
      BEGIN
        IF OLD."purgeProtected" THEN
          RAISE EXCEPTION 'tenant % is purge-protected [STA-1 DL-8]: clear purgeProtected in its own statement before deleting it', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tenants_purge_guard ON tenants;
CREATE TRIGGER tenants_purge_guard BEFORE DELETE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_purge_guard();
