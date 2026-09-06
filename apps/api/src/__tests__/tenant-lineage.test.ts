/**
 * [STA-1 Part 4] Tenant LINEAGE — the models that carry no tenantId.
 *
 * The tenant wall (RLS + Prisma scoping) walls the 80 models that carry a
 * tenantId column. Everything else is walled only through a parent, or is
 * platform-wide by design, or is PENDING the child-table EXPAND (STA-1 §4).
 * This test is a RATCHET: every model without tenantId must be in exactly one
 * checked-in register, with its parent or its reason, and a model that gains
 * tenantId must leave the register. No child table ships walled-by-parent
 * silently again (the /home leak of 2026-09-05 was exactly that).
 *
 * Generated from the DMMF on 2026-09-05; edit the registers, not the rule.
 * 2026-09-05 (later): Item and Category left the register — they carry tenantId now (the exemplar EXPAND).
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

/** Walled ONLY through these tenant-bearing parents (FK holder → parent). */
export const WALLED_BY_PARENT: Record<string, readonly string[]> = {
  Session: ['User'],
  DeviceToken: ['User'],
  Address: ['User'],
  VerificationDocument: ['User', 'DocLegalHold', 'Subject'],
  ComplianceViolation: ['User'],
  ComplianceReviewCase: ['User'],
  Strike: ['User'],
  Customer: ['User'],
  Rider: ['User'],
  Driver: ['User'],
  VendorOwner: ['User'],
  VendorStaff: ['Vendor', 'User'],
  VendorImage: ['Vendor'],
  OperatingHours: ['Vendor'],
  Booking: ['Item'],
  OptionGroup: ['Item'],
  OrderItem: ['Order'],
  StockAdjustment: ['Item'],
  OrderStatusLog: ['Order'],
  Rating: ['User'],
  ServiceProvider: ['User'],
  Subscription: ['Vendor'],
  SupportTicket: ['User', 'Order'],
  PromoCode: ['Vendor'],
  PromoRedemption: ['Order'],
  Notification: ['User'],
  ZoneFare: ['Zone'],
  ChatRoomParticipant: ['User'],
  Admin: ['User'],
  AccountRecovery: ['User'],
  Cart: ['User', 'Vendor'],
  CartItem: ['Item'],
  EvidenceItem: ['EvidenceBundle'],
  AdvertiserMember: ['Advertiser'],
  AdInventoryWeek: ['AdPlacement'],
  AdCreative: ['AdCampaign'],
  AdBooking: ['AdCampaign'],
  RunStop: ['DeliveryRun'],
};

/** Walled through a parent that is itself only walled by lineage — two or more hops from the tenant. */
export const GRANDCHILD_OF: Record<string, string> = {
  Option: 'OptionGroup',
  OrderItemOption: 'OrderItem',
  BillingEvent: 'Subscription',
  PrepaidBalance: 'Subscription',
  SubscriptionPayment: 'Subscription',
  SubscriptionRefund: 'Subscription',
  PromoTerms: 'PromoCode',
  ServiceQualification: 'ServiceProvider',
};

/** Platform-wide by design — the reason a reviewer can check. */
export const PLATFORM_WIDE: Record<string, string> = {
  DocType: 'the document registry (DOC-1 §4.2) — data keyed by country, like CountryConfig',
  DocField: 'fields of a registry document class',
  CategoryDocumentGate: 'the category document gate (DOC-1 §18.3) — country-keyed registry data like doc_type',
  Validator: 'the validator registry (DOC-1 §7.1) — global data like the document registry it proves',
  AuditChainEntry: 'the tamper-evident audit chain (DOC-1 §20.1) — one platform-wide sequence of digests, never bodies',
  AuditChainAnchor: 'the daily head of the audit chain — a digest, platform-wide',
  DocStateTransition: 'the document state machine transition table (DOC-1 §5.1) — global rule data, mirrored from doc-state.ts',
  RequirementSet: 'a market’s checklist for an actor role — country-keyed registry data',
  RequirementItem: 'items of a requirement set',
  ChatMessage: 'messages of participant-addressed rooms (ChatRoom is platform-wide)',
  IdentityClusterMember: 'members of the identity graph (IdentityCluster is the sanctioned cross-tenant system)',
  LedgerEntry: 'entries of the platform ledger (LedgerTransaction is platform-wide)',
  Tenant: 'the tenant registry itself',
  CountryConfig: 'market configuration, keyed by country not operator',
  PricingConfigVersion: 'pricing versions are platform history',
  RetentionPolicy: 'retention clocks are platform law',
  RetentionSweepReceipt: 'receipts of the platform sweep',
  LegalDocument: 'published legal texts, one per version',
  PlatformConfig: 'platform-wide switches',
  IntegritySettings: 'platform-wide abuse dials',
  PriceBookEntry: 'the platform price book',
  FxRate: 'exchange rates',
  DeploymentIdentity: 'one row per deployment',
  SweepCursor: 'job cursors',
  ComplianceAuditRun: 'platform compliance runs',
  CwRun: 'control-window runs',
  CwAlert: 'control-window alerts',
  AlertDelivery: 'ops alert deliveries',
  DispatchSearch: 'dispatch search telemetry',
  MoverRevocationOutbox: 'revocation outbox keyed by mover id',
  AgentActionRequest: 'agent (AI) action requests — platform ops',
  AgentAuditEvent: 'agent audit trail — platform ops',
  PrivilegedChangeAudit: 'privileged-change audit trail',
  AuditLog: 'the admin audit trail — actor-scoped, not operator-scoped (ADM-002 rows name their entity)',
  AdEventDedupe: 'dedupe keys',
  AdFreqCounter: 'frequency counters',
  AdStatsDaily: 'daily ad stats keyed by placement',
  IdentityCluster: 'trial-abuse identity graph — the one sanctioned cross-tenant system (like IdentityKey)',
  FaceTemplate: 'face-match templates — identity system',
  EnforcementAction: 'identity-graph enforcement',
  ExceptionGrant: 'identity-graph exceptions',
  SignupAttempt: 'pre-account signup attempts — no tenant exists yet',
  ConsentRecord: 'legal consent evidence per person, bound by version not operator',
  LedgerAccount: 'platform ledger accounts',
  LedgerTransaction: 'platform ledger transactions',
  ChatRoom: 'chat rooms are addressed by participants (ChatRoomParticipant <- User)',
  EncryptedObject: 'envelope-encrypted blobs addressed by key; the owning row is the wall',
};

/** Honestly PENDING: reachable from a tenant only through FK-less string references.
 *  Each is an EXPAND candidate under the child-table contract; none may be added
 *  here without a named follow-up. */
export const PENDING_EXPAND: Record<string, string> = {
  ReimbursementClaim: 'FK-less rider/order references',
  ReturnRequest: 'FK-less order reference',
  CollectionContact: 'FK-less subscription/vendor reference',
  ContentReport: 'FK-less reporter/subject references',
};

const models = Prisma.dmmf.datamodel.models;
const carriesTenant = new Set(models.filter((m) => m.fields.some((f) => f.name === 'tenantId')).map((m) => m.name));
const fkParents = (m: (typeof models)[number]) =>
  [...new Set(m.fields.filter((f) => f.kind === 'object' && (f.relationFromFields ?? []).length > 0).map((f) => f.type))];
const without = models.filter((m) => !carriesTenant.has(m.name));
const registered = (name: string) =>
  [WALLED_BY_PARENT, GRANDCHILD_OF, PLATFORM_WIDE, PENDING_EXPAND].filter((r) => name in r).length;

describe('[STA-1 §4] tenant lineage — every model without tenantId is accounted for, exactly once', () => {
  it('the census is not vacuous', () => {
    expect(carriesTenant.size).toBeGreaterThanOrEqual(80);
    expect(without.length).toBeGreaterThanOrEqual(40);
  });

  it('every model without tenantId is in EXACTLY one register', () => {
    const missing = without.filter((m) => registered(m.name) === 0).map((m) => m.name);
    const doubled = without.filter((m) => registered(m.name) > 1).map((m) => m.name);
    expect(missing, 'new model without tenantId — give it tenantId, or register it with its parent or reason').toEqual([]);
    expect(doubled).toEqual([]);
  });

  it('a model registered as walled-by-parent names exactly its tenant-bearing FK parents', () => {
    const wrong: string[] = [];
    for (const m of without) {
      const parents = fkParents(m).filter((p) => carriesTenant.has(p)).sort();
      const claimed = WALLED_BY_PARENT[m.name];
      if (parents.length > 0 && (!claimed || [...claimed].sort().join(',') !== parents.join(','))) wrong.push(`${m.name}: parents=${parents.join(',')} claimed=${claimed?.join(',') ?? 'none'}`);
      if (parents.length === 0 && claimed) wrong.push(`${m.name}: claimed parents but has no tenant-bearing FK parent`);
    }
    expect(wrong).toEqual([]);
  });

  it('a grandchild names a parent that exists and whose own lineage is accounted for', () => {
    const names = new Set(models.map((m) => m.name));
    const bad = Object.entries(GRANDCHILD_OF).filter(([, p]) => !p.split('/').every((x) => names.has(x) && (carriesTenant.has(x) || registered(x) > 0)));
    expect(bad).toEqual([]);
  });

  it('the registers hold no stale names — a model that gained tenantId, or was deleted, leaves', () => {
    const stale = [WALLED_BY_PARENT, GRANDCHILD_OF, PLATFORM_WIDE, PENDING_EXPAND]
      .flatMap((r) => Object.keys(r))
      .filter((n) => !without.some((m) => m.name === n));
    expect(stale).toEqual([]);
  });

  it('every reason is a sentence a reviewer can check, not a placeholder', () => {
    for (const r of [PLATFORM_WIDE, PENDING_EXPAND, GRANDCHILD_OF]) for (const v of Object.values(r)) expect(v.length).toBeGreaterThan(3);
  });
});

