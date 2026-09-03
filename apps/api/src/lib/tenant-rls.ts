/**
 * [ELV-1 W-201 / F-201] The database tenant wall.
 *
 * Application-layer scoping covers a fraction of the tenant-bearing models
 * (TENANT_TABLES below is the authoritative census — 52 at last count, and
 * the census test keeps it 1:1 with the DMMF so this prose can never be the
 * source of truth again), and raw SQL bypasses it entirely — so isolation
 * ultimately rests on developer discipline. Row-Level Security makes it structural: PostgreSQL itself
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
  // [S-01] The SOS escalation outbox belongs to the alert's tenant.
  'sos_escalations',
  // [MKT-2] the stock ledger: one operator's inventory movements.
  'stock_movements',
  // [R048-007] money-surface commands: one operator's decided money changes.
  'money_surface_commands',
  'sos_retriggers',
  'guardian_checkin_deliveries',
  'legal_holds',
  'ops_alerts',
  'ops_alert_recipients',
  // [ALGO Band 0.2] Algorithm tunables are tenant-owned: one operator's dials
  // must never be readable through another's session.
  'algo_config',
  // [ALGO Band 0.3] Decisions are evidence about one operator's people.
  'algo_decisions',
  'vendor_prep_stats',
  'eta_pad_stats',
  'ad_campaigns', 'ad_events', 'ad_invoices', 'ad_placements',
  'ad_refund_intents', 'ad_refund_items', 'ad_refund_outbox', 'ads_audit_log',
  'ads_settings', 'advertisers', 'attribution_claims', 'batch_evaluations',
  'batching_settings', 'booking_exceptions',
  // [M-11] The checkout command's durable result and tail.
  'checkout_receipts',
  'delivery_runs',
  // [M-22] Immutable bank deposit confirmations and their adjustments.
  'deposit_confirmations',
  'discovery_categories', 'discovery_category_requests',
  'discovery_category_suggestions', 'fee_receipts', 'house_ads',
  'identity_keys', 'item_discovery_categories', 'item_feedbacks',
  'mmg_agent_payments', 'order_outbox', 'orders', 'pending_attributions',
  // [M-18] One provider transaction, one identity, one credit.
  'provider_payments', 'qr_codes',
  'rating_reports', 'rating_tag_defs', 'receipt_counters',
  'ride_queue_entries', 'san_tombstones', 'scan_daily_rollups', 'scan_events',
  // [TA-S1-006] A service job is one operator's incident scope: its SOS routes by this column.
  'service_jobs',
  'settlement_batches',
  // [M-20] A settlement file as one staged, validated import.
  'settlement_imports', 'slug_redirects', 'storage_orphans', 'supply_watches',
  'tenant_billing_currency',
  // [M-08] The prepaid top-up as one persisted command.
  'topup_commands', 'trial_grants', 'trip_share_tokens',
  // [M-34] Fare zones are one operator's, in one market.
  'zones',
  // [STORE-002] Who a person refuses contact with.
  'user_blocks',
  'users',
  'vendor_discovery_categories', 'vendors',
] as const;

export const TENANT_POLICY_NAME = 'tenant_isolation';

/** The row predicate: the request's tenant, or membership in the
 *  swift_bypass_rls role — a ROLE CAPABILITY, not a GUC, because a GUC is
 *  settable by the very role the wall constrains [REPORT-021 F-021-11].
 *  current_setting(..., true) returns NULL (not an error) when unset, so a
 *  connection with NO tenant context matches nothing — fail closed. */
const POLICY_PREDICATE = `("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))`;

/** Does a policy expression READ BACK from PostgreSQL still say what
 *  POLICY_PREDICATE says?
 *
 *  [F-021-11 repair] It has to be a predicate over the stored expression
 *  rather than string equality with the literal above: PostgreSQL reparses and
 *  re-renders `qual`/`with_check` (adding `::text` casts, uppercasing
 *  CURRENT_USER, normalising parentheses), so the text it hands back never
 *  matches the text we sent. What must hold is the MEANING — scoped by the
 *  request's tenant, and bypassed only by a role capability a constrained role
 *  cannot grant itself.
 *
 *  This lives here, three lines under the predicate it describes, so the two
 *  cannot drift apart unnoticed. `20260828120000_algo_config` is why it
 *  exists: it installed its policy by copying an older migration's DDL text
 *  instead of calling rlsDdlFor(), and shipped the retired GUC bypass onto the
 *  one table holding the algorithm tunables. Every layer that should have
 *  caught it was counting policies, not reading them. */
export function policyPredicateIsCanonical(expression: string | null | undefined): boolean {
  if (!expression) return false;
  return expression.includes('app.current_tenant')
    && expression.includes('pg_has_role')
    // The retired form. Named explicitly because its absence is the whole
    // point of the repair, and a silent re-appearance is what we are guarding.
    && !expression.includes('app.bypass_tenant');
}

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

/** [W-201b] The future app role + grants, idempotent (mirrors migration
 *  20260819150000; the test installer heals db-push environments). NOLOGIN —
 *  no credentials in a public repo; deploy provisions LOGIN out-of-band. */
export function appRoleDdl(): string[] {
  return [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_bypass_rls') THEN
        CREATE ROLE swift_bypass_rls NOLOGIN NOBYPASSRLS;
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_app') THEN
        CREATE ROLE swift_app NOLOGIN NOBYPASSRLS;
      END IF;
    END $$`,
    `GRANT USAGE ON SCHEMA public TO swift_app`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_app`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_app`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO swift_app`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swift_app`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO swift_app`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO swift_app`,
  ];
}

/** [TEN-03 · runbook] The CONTRACT stage, as statements: FORCE RLS on every
 *  walled table (so even the owner is subject to the policies) — applied by
 *  the founder's approved migration once the app connects as the
 *  least-privilege login (a member of swift_app, NOBYPASSRLS). Derived from
 *  the census, never hand-written. */
export function forceRlsStatements(): string[] {
  return TENANT_TABLES.map((t) => `ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
}
