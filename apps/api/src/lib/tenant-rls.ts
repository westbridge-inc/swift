/**
 * [ELV-1 W-201 / F-201] The database tenant wall.
 *
 * Application-layer scoping covers 14 of 51 tenant-bearing models, and raw
 * SQL bypasses it entirely — so isolation ultimately rests on developer
 * discipline. Row-Level Security makes it structural: PostgreSQL itself
 * refuses to show tenant A's rows to a request bound to tenant B.
 *
 * Rollout is staged (expand → verify → contract, D-010):
 *  - EXPAND (this module + its migration): policies exist on every table
 *    below, RLS ENABLED but not FORCED. The app connects as the table owner,
 *    and owners bypass non-forced RLS — zero behavior change, fully proven
 *    by the suite.
 *  - VERIFY: tenant-rls.test.ts binds a NOBYPASSRLS probe role and proves
 *    A-sees-only-A, no-context-sees-NOTHING (fail closed), bypass-GUC for
 *    sanctioned cross-tenant work, and that raw SQL is equally walled.
 *  - CONTRACT (later, deliberate): the app moves to a NOBYPASSRLS role and
 *    RLS is FORCED; per-request SET LOCAL app.current_tenant comes from the
 *    tenant ALS context. Only then does the wall bind the app itself.
 *
 * TENANT_TABLES is asserted 1:1 against the Prisma DMMF by the census test —
 * a new model carrying tenantId that is not listed here goes RED, the same
 * pattern that keeps the app-scope list honest (F-0008).
 */

export const TENANT_TABLES = [
  'EmergencyContact', 'EvidenceBundle', 'IncidentCase', 'LivenessCheck',
  'SafetyAccessLog', 'SosAlert', 'TripSafetySession', 'actor_rating_stats',
  'ad_campaigns', 'ad_events', 'ad_invoices', 'ad_placements',
  'ad_refund_intents', 'ad_refund_items', 'ad_refund_outbox', 'ads_audit_log',
  'ads_settings', 'advertisers', 'attribution_claims', 'batch_evaluations',
  'batching_settings', 'booking_exceptions', 'delivery_runs',
  'discovery_categories', 'discovery_category_requests',
  'discovery_category_suggestions', 'fee_receipts', 'house_ads',
  'identity_keys', 'item_discovery_categories', 'item_feedbacks',
  'mmg_agent_payments', 'orders', 'pending_attributions', 'qr_codes',
  'rating_reports', 'rating_tag_defs', 'receipt_counters',
  'ride_queue_entries', 'san_tombstones', 'scan_daily_rollups', 'scan_events',
  'settlement_batches', 'slug_redirects', 'supply_watches',
  'tenant_billing_currency', 'trial_grants', 'trip_share_tokens', 'users',
  'vendor_discovery_categories', 'vendors',
] as const;

export const TENANT_POLICY_NAME = 'tenant_isolation';

/** The row predicate: the request's tenant, or the sanctioned bypass for
 *  cross-tenant system work. current_setting(..., true) returns NULL (not an
 *  error) when unset, so a connection with NO tenant context matches nothing
 *  — fail closed. */
const POLICY_PREDICATE = `("tenantId" = current_setting('app.current_tenant', true)
      OR current_setting('app.bypass_tenant', true) = 'on')`;

/** Idempotent DDL for one table. Also used by the test installer so db-push
 *  provisioned environments (CI API tests) carry the wall too. */
export function rlsDdlFor(table: string): string[] {
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS "${TENANT_POLICY_NAME}" ON "${table}"`,
    `CREATE POLICY "${TENANT_POLICY_NAME}" ON "${table}"
      USING (${POLICY_PREDICATE})
      WITH CHECK (${POLICY_PREDICATE})`,
  ];
}

export function allRlsDdl(): string[] {
  return TENANT_TABLES.flatMap((t) => rlsDdlFor(t));
}
