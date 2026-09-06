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
  'rating_outbox',
  'privileged_approvals',
  'sensitive_read_logs',
  // [STA-1 Part 4] The reviewer fiction is walled like every other tenant's rows.
  'review_sessions',
  'review_credentials',
  'review_fixtures',
  // [STA-1 §4 lineage] Child tables walled on the row itself, not only through their vendor.
  'items',
  'categories',
  // [STA-1 §4 lineage · money] personal and operator money rows, walled on the row itself.
  // (No apostrophes in comments inside this array: the CI gate extracts the names by quote.)
  'transactions',
  'earnings',
  'settlements',
  'delivery_cash_settlements',
  'payout_requests',
  'payout_schedules',
  // [DOC-1 DOC-INV-7] proof of purge is evidence about a person: walled like the person.
  'deletion_receipt',
  // [DOC-1 P4-5] human review of a document is about the person: walled like the person.
  'review_case',
  'review_decision',
  // [DOC-1 P4-4] the extraction ledger of a submission
  'extraction_run',
  'extracted_field',
  'validation_result',
  // [DOC-1 P9-4] a legal hold on a person s documents
  'doc_legal_hold',
  // [DOC-1 P4-7] the renewal schedule of an approved document
  'renewal_schedule',
  // [DOC-1 P25] a request to correct an extracted field
  'rectification_request',
  // [DOC-1 P24] a fraud case confirmed on second review
  'fraud_case',
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
  'ride_queue_entries', 'safety_deletion_holds', 'san_tombstones',
  'scan_daily_rollups', 'scan_events',
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
    // [STA-1 4.2] FORCE: without it the table OWNER bypasses the policy — the
    // exact role the app becomes if pooling is misconfigured. Superusers still
    // bypass (Postgres law), which is why the deploy role must never be one.
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS "${TENANT_POLICY_NAME}" ON "${table}"`,
    `CREATE POLICY "${TENANT_POLICY_NAME}" ON "${table}"
      USING (${POLICY_PREDICATE})
      WITH CHECK (${POLICY_PREDICATE})`,
  ];
}

/** [STA-1 DL-8] A purge-protected tenant cannot be DELETEd — not by the go-live
 *  purge, not by a bulk cleanup, not by a cascading mistake. Clearing the flag
 *  is its own deliberate statement; the trigger refuses everything else.
 *  Mirrors migration 20260905000000_review_tenant; the test installer heals
 *  db-push environments with the same text. */
export const TENANT_PURGE_GUARD = 'tenants_purge_guard';
export function tenantPurgeGuardDdl(): string[] {
  return [
    `CREATE OR REPLACE FUNCTION ${TENANT_PURGE_GUARD}() RETURNS trigger AS $$
      BEGIN
        IF OLD."purgeProtected" THEN
          RAISE EXCEPTION 'tenant % is purge-protected [STA-1 DL-8]: clear purgeProtected in its own statement before deleting it', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS ${TENANT_PURGE_GUARD} ON tenants`,
    `CREATE TRIGGER ${TENANT_PURGE_GUARD} BEFORE DELETE ON tenants FOR EACH ROW EXECUTE FUNCTION ${TENANT_PURGE_GUARD}()`,
  ];
}

/** [STA-1 §4 lineage] A child row's tenant IS its parent's tenant — always.
 *  The wall stamps tenantId from the request context; this holds it equal to
 *  the vendor's on the row itself. A row left at the DEFAULT tenant (created in
 *  system mode, unstamped) is DERIVED from its parent — the default means
 *  "unstamped", never "production". An explicit tenant that disagrees with the
 *  parent is REFUSED, and so is a parent that is not visible from this tenant
 *  (under RLS a vendor of another tenant is invisible — fail closed). Mirrors
 *  the migration text; the test installer heals db-push environments. */
export interface TenantLineageRule {
  table: string;
  trigger: string;
  /** The parent whose tenant the row inherits (one hop), or a SQL expression yielding it. */
  parent: string;
  fk: string;
  /** For two-hop lineage: a SELECT returning the parent's tenant for NEW. Defaults to `SELECT "tenantId" FROM <parent> WHERE id = NEW."<fk>"`. */
  parentTenantSql?: string;
  /** Columns whose UPDATE re-checks lineage (the fk by default). */
  watch?: readonly string[];
}
export const TENANT_LINEAGE_TABLES: readonly TenantLineageRule[] = [
  { table: 'items', trigger: 'items_tenant_matches_vendor', parent: 'vendors', fk: 'vendorId' },
  { table: 'categories', trigger: 'categories_tenant_matches_vendor', parent: 'vendors', fk: 'vendorId' },
  // [money] one hop through the owner
  { table: 'transactions', trigger: 'transactions_tenant_matches_user', parent: 'users', fk: 'userId' },
  { table: 'payout_requests', trigger: 'payout_requests_tenant_matches_user', parent: 'users', fk: 'userId' },
  { table: 'payout_schedules', trigger: 'payout_schedules_tenant_matches_user', parent: 'users', fk: 'userId' },
  { table: 'settlements', trigger: 'settlements_tenant_matches_vendor', parent: 'vendors', fk: 'vendorId' },
  { table: 'delivery_cash_settlements', trigger: 'delivery_cash_settlements_tenant_matches_order', parent: 'orders', fk: 'orderId' },
  // [money] two hops: an earning belongs to its mover (rider OR driver), who belongs to a user, who belongs to a tenant
  // [DOC-1 P4-5] a review case inherits through the document to the person; a decision inherits its case
  { table: 'review_case', trigger: 'review_case_tenant_matches_subject', parent: 'users', fk: 'submissionId',
    parentTenantSql: `SELECT u."tenantId" FROM users u JOIN verification_documents d ON d."userId" = u.id WHERE d.id = NEW."submissionId"` },
  { table: 'review_decision', trigger: 'review_decision_tenant_matches_case', parent: 'review_case', fk: 'caseId' },
  // [DOC-1 P4-4] a run and a validation verdict inherit through the document to the person; a field inherits its run
  { table: 'extraction_run', trigger: 'extraction_run_tenant_matches_subject', parent: 'users', fk: 'submissionId',
    parentTenantSql: `SELECT u."tenantId" FROM users u JOIN verification_documents d ON d."userId" = u.id WHERE d.id = NEW."submissionId"` },
  { table: 'extracted_field', trigger: 'extracted_field_tenant_matches_run', parent: 'extraction_run', fk: 'runId' },
  { table: 'validation_result', trigger: 'validation_result_tenant_matches_subject', parent: 'users', fk: 'submissionId',
    parentTenantSql: `SELECT u."tenantId" FROM users u JOIN verification_documents d ON d."userId" = u.id WHERE d.id = NEW."submissionId"` },
  // [DOC-1 P9-4] a legal hold inherits the tenant of the person whose documents it holds
  { table: 'doc_legal_hold', trigger: 'doc_legal_hold_tenant_matches_subject', parent: 'users', fk: 'subjectUserId' },
  { table: 'renewal_schedule', trigger: 'renewal_schedule_tenant_matches_subject', parent: 'users', fk: 'subjectId' },
  { table: 'rectification_request', trigger: 'rectification_request_tenant_matches_user', parent: 'users', fk: 'userId' },
  { table: 'fraud_case', trigger: 'fraud_case_tenant_matches_subject', parent: 'users', fk: 'subjectUserId' },
  { table: 'earnings', trigger: 'earnings_tenant_matches_mover', parent: 'users', fk: 'orderId', watch: ['riderId', 'driverId', 'orderId'],
    // rider → driver → the ORDER: an earning exists before a mover is bound (order.service creates the
    // rows at placement), so the order is the owner of last resort; an earning with none is refused.
    parentTenantSql: `SELECT COALESCE((SELECT u."tenantId" FROM users u JOIN riders r ON r."userId" = u.id WHERE r.id = NEW."riderId"), (SELECT u."tenantId" FROM users u JOIN drivers d ON d."userId" = u.id WHERE d.id = NEW."driverId"), (SELECT o."tenantId" FROM orders o WHERE o.id = NEW."orderId"))` },
];
export function tenantLineageDdl(): string[] {
  return TENANT_LINEAGE_TABLES.flatMap(({ table, trigger, parent, fk, parentTenantSql, watch }) => [
    `CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        ${parentTenantSql ?? `SELECT "tenantId" FROM ${parent} WHERE id = NEW."${fk}"`} INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION '${table} row % names ${parent} row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."${fk}" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION '${table} row % names tenant % but its ${parent} row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."${fk}", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS ${trigger} ON ${table}`,
    `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE OF "tenantId", ${(watch ?? [fk]).map((c) => `"${c}"`).join(', ')} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  ]);
}

/** [DOC-INV-7] A receipt that can be edited proves nothing. Mirrors migration 20260905180000. */
export function deletionReceiptAppendOnlyDdl(): string[] {
  return [
    `CREATE OR REPLACE FUNCTION deletion_receipt_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'deletion_receipt is append-only [DOC-INV-7]' USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS deletion_receipt_append_only ON deletion_receipt`,
    `CREATE TRIGGER deletion_receipt_append_only BEFORE UPDATE OR DELETE ON deletion_receipt FOR EACH ROW EXECUTE FUNCTION deletion_receipt_append_only()`,
  ];
}

/** [STA-1 DL-4] isSynthetic is a FACT of the tenant, not a flag anyone sets:
 *  a row in a REVIEW or CRAWLER tenant is synthetic (derived on write — the
 *  default `false` means "unstamped"), and a row in a PRODUCTION tenant can
 *  never be marked synthetic (refused). Aggregates that read `isSynthetic`
 *  (lib/production-only.ts) therefore cannot be lied to by a seed that forgot
 *  the flag, or by a production row that borrowed it. Mirrors migration
 *  20260905190000_synthetic_derivation; the test installer heals db-push envs. */
export const SYNTHETIC_TABLES = ['users', 'vendors'] as const;
export function syntheticDerivationDdl(): string[] {
  return SYNTHETIC_TABLES.flatMap((table) => [
    `CREATE OR REPLACE FUNCTION ${table}_synthetic_matches_tenant() RETURNS trigger AS $$
      DECLARE tenant_kind TEXT;
      BEGIN
        SELECT kind::text INTO tenant_kind FROM tenants WHERE id = NEW."tenantId";
        IF tenant_kind IS NULL THEN RETURN NEW; END IF; -- the FK, not this trigger, judges a missing tenant
        IF tenant_kind <> 'PRODUCTION' THEN
          NEW."isSynthetic" := true;
        ELSIF NEW."isSynthetic" THEN
          RAISE EXCEPTION '${table} row % is in PRODUCTION tenant % and cannot be synthetic [STA-1 DL-4]', NEW.id, NEW."tenantId"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS ${table}_synthetic_matches_tenant ON ${table}`,
    `CREATE TRIGGER ${table}_synthetic_matches_tenant BEFORE INSERT OR UPDATE OF "isSynthetic", "tenantId" ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_synthetic_matches_tenant()`,
  ]);
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
