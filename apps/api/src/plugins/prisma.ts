import { PrismaClient } from '@prisma/client';
import { unscopedAccessPolicy, rlsBindEnabled } from '../lib/rls-attestation';
export { unscopedAccessPolicy, rlsBindEnabled };
import { destructiveGuardExtension, isTestRuntime } from '../lib/test-target-lock';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { getTenantContext, tenantContext, type TenantMode } from './tenant-context';
import { tenantUnscopedAccessCounter, tenantBindCounter } from './observability';
import { poolRoleForApiProcess, resolveDatabaseUrl } from '../utils/db-pool';
import { isDevelopment } from '../utils/runtime-mode';

// Multi-tenancy stage 2 — tenant scoping at the ORM layer. When a request has
// bound a tenant (tenant-context), EVERY direct operation on a tenant-owned
// model is qualified to it. Prisma 6 WhereUniqueInput accepts extra non-unique
// predicates as long as one unique field remains at the top level, so an id is
// never treated as authorization: findUnique/update/delete/upsert all carry the
// tenant predicate too. Writes stamp tenantId LAST so request-controlled data
// cannot create or move a row across tenants. No context set (explicit system,
// test and pre-auth work) remains unscoped.
// [F-0008] Every model carrying a tenantId column belongs here unless it is on
// the reasoned exemption list in tenant-coverage.test.ts. That test walks the
// Prisma DMMF at run time and fails if a model carrying tenantId is in neither
// place — so this list can no longer silently fall behind the schema, which is
// how it came to cover 10 of 47 models.
//
// Enrolling was deliberately done while Swift is single-tenant: injecting
// `tenantId: 'swift-default'` matches every existing row, so it is a no-op
// today and correct the moment a second operator exists. Doing it after that
// point would have been a migration; doing it now is free.
/**
 * [F-0008] Every tenant-owned model, by its Prisma client property name.
 *
 * ONE list. Both the scoping predicate and the `$extends` registration below are
 * derived from it, so they cannot drift apart — the previous shape maintained a
 * lowercase Set and a hand-written registration block separately, which is how
 * a model could be "registered" in one and missing from the other.
 *
 * tenant-coverage.test.ts walks the Prisma DMMF at run time and fails if any
 * model carrying a tenantId column is in neither this list nor the reasoned
 * exemption list there — so this can no longer silently fall behind the schema,
 * which is how it came to cover 10 of 47 models.
 *
 * Enrolling the missing 35 was deliberately done while Swift is single-tenant:
 * injecting `tenantId: 'swift-default'` matches every row that exists, so it is
 * a no-op today and correct the moment a second operator is provisioned. After
 * that point the same change would have needed a backfill and a migration.
 */
const scoped = { $allOperations: (params: ScopeParams) => tenantScope(params, 'request') };

/**
 * The registration itself is the single source of truth. Prisma type-checks
 * every key here against the real model set, so a typo or a renamed model is a
 * compile error; and `TENANT_MODELS` plus the exported name list are both
 * derived from it below, so the predicate, the registration and the test can
 * never disagree. (The previous shape kept a lowercase Set and this block as
 * two hand-maintained lists — that is how a model could be in one and not the
 * other.)
 */
const TENANT_QUERY_EXTENSIONS = {
  user: scoped, vendor: scoped, order: scoped,
  handoverPhotoProof: scoped, cashHandoverEvidence: scoped, mmgPayerEvidence: scoped, identityReviewCase: scoped,
  // QR growth engine: codes + scan analytics are tenant-owned rows. The public
  // /s/:code resolver runs pre-auth (no context) and stays unscoped by design —
  // a shortCode is globally unique and names its own tenant.
  qrCode: scoped, scanEvent: scoped,
  // Category discovery (#17): taxonomy + tags + suggestions + requests.
  discoveryCategory: scoped, vendorDiscoveryCategory: scoped, itemDiscoveryCategory: scoped,
  discoveryCategorySuggestion: scoped, discoveryCategoryRequest: scoped,
  // Safety spine — SOS, guardian sessions, incidents and their evidence.
  // [TA-S1-006] A hired-professional job is one operator's incident scope.
  serviceJob: scoped,
  // [M-11] The checkout command's durable tail and result are one operator's rows.
  orderOutbox: scoped, checkoutReceipt: scoped,
  // [M-34] Fare zones are one operator's, in one market.
  zone: scoped,
  sosAlert: scoped, emergencyContact: scoped, tripShareToken: scoped, tripSafetySession: scoped,
  // [S-01] The escalation outbox rides with the alert.
  sosEscalation: scoped,
  sosRetrigger: scoped,
  guardianCheckinDelivery: scoped,
  legalHold: scoped,
  opsAlert: scoped,
  opsAlertRecipient: scoped,
  livenessCheck: scoped, incidentCase: scoped, evidenceBundle: scoped, safetyAccessLog: scoped,
  // [AG-XF-013] The deletion escrow holds one tenant's people; the retention
  // sweep runs without tenant context and is therefore deliberately unscoped.
  safetyDeletionHold: scoped,
  // Money: settlement, receipts, the agent-cash rail, trials.
  mmgAgentPayment: scoped, settlementBatch: scoped, feeReceipt: scoped, receiptCounter: scoped,
  // [M-22] Immutable bank deposit confirmations and their adjustments.
  depositConfirmation: scoped,
  // [M-20] A settlement file as one staged, validated import.
  settlementImport: scoped,
  // [M-18] The provider-transaction identity behind every agent-cash observation.
  providerPayment: scoped,
  // [MMG checkout 2/6] A partner's MMG checkout and every observation of it.
  mmgCheckoutIntent: scoped, mmgCheckoutKey: scoped, mmgCheckoutObservation: scoped,
  billingDunningClock: scoped, billingObligationTransition: scoped, paymentConfirmationHold: scoped, billingFeeNotice: scoped, billingNoticeHandoff: scoped,
  tenantBillingCurrency: scoped, trialGrant: scoped,
  moverFeeAuthority: scoped, moverFeeSubscription: scoped,
  // [M-08] The prepaid top-up as one persisted command.
  topUpCommand: scoped,
  // [PT-1] Card rail v2: an enrolled card, a hosted session, and the evidence
  // of every provider answer all belong to the payer's operator.
  paymentInstrument: scoped, cardSession: scoped, cardObservation: scoped,
  // Ads platform.
  advertiser: scoped, adPlacement: scoped, adCampaign: scoped, adInvoice: scoped,
  adRefundIntent: scoped, adRefundItem: scoped, adRefundOutbox: scoped,
  adEvent: scoped, houseAd: scoped, adsSettings: scoped, adsAuditLog: scoped,
  // Ratings.
  actorRatingStat: scoped, ratingReport: scoped, itemFeedback: scoped, ratingTagDef: scoped,
  // [STORE-002] Who a person refuses contact with is theirs and their
  // operator's; it must never be readable or writable through another's
  // session. (ContentReport beside it carries no tenantId and is therefore not
  // here — a pre-existing shape, not a decision made by this change.)
  userBlock: scoped,
  // Growth / QR attribution.
  slugRedirect: scoped, pendingAttribution: scoped, attributionClaim: scoped, scanDailyRollup: scoped,
  // Batching + scheduling.
  deliveryRun: scoped, batchEvaluation: scoped, batchingSettings: scoped, bookingException: scoped,
  // [ALGO Band 0.2] Algorithm tunables are tenant-owned: one operator's dials
  // must never be read or written through another's session.
  algoConfig: scoped,
  // [ALGO Band 0.3] The decision log: one operator's evidence, never another's.
  algoDecision: scoped,
  vendorPrepStat: scoped,
  etaPadStat: scoped,
  rideQueueEntry: scoped,
  // [TAXI multi-stop] The intermediate stops of a ride belong to its operator, like the ride.
  taxiTripStop: scoped,
  // [AF-MOB-006] A custody recovery case belongs to its order's operator.
  custodyRecoveryCase: scoped,
  // [REPORT-014 F-014-03] Supply watches are tenant rows: demand counts and
  // recovery notifications must never see another operator's watchers.
  supplyWatch: scoped,
  // [F-026-02] The storage-deletion census carries tenant rows (a selfie key
  // belongs to its user's tenant); the opportunistic retry therefore works
  // within the acting tenant — the obligation is discharged per tenant.
  storageOrphan: scoped,
  // [R048-007] A money-surface command carries the authority to change an
  // operator's money. It is tenant-owned like the surface it acts on.
  moneySurfaceCommand: scoped,
  // [E02] What a store owes a customer back by MMG, and the transfers it says
  // it sent: one operator's customers and money, walled like their order.
  mmgRefundObligation: scoped,
  mmgRefundSend: scoped,
  ratingOutbox: scoped,
  privilegedApproval: scoped,
  sensitiveReadLog: scoped,
  // [MKT-2] The stock ledger is tenant-owned: one operator's inventory
  // history must never be readable through another's session.
  stockMovement: scoped,
  // [STA-1 Part 4] the reviewer fiction: one tenant's sessions, credentials, fixtures.
  reviewSession: scoped,
  reviewCredential: scoped,
  reviewFixture: scoped,
  // [STA-1 §4 lineage] child tables now walled on the row itself.
  item: scoped,
  category: scoped,
  // [STA-1 §4 lineage · money]
  transaction: scoped,
  earning: scoped,
  settlement: scoped,
  deliveryCashSettlement: scoped,
  payoutRequest: scoped,
  payoutSchedule: scoped,
  deletionReceipt: scoped,
  reviewCase: scoped,
  reviewDecision: scoped,
  // [DOC-1 P4-4] the extraction ledger of a submission
  extractionRun: scoped,
  extractedField: scoped,
  validationResult: scoped,
  // [DOC-1 P9-4]
  docLegalHold: scoped,
  renewalSchedule: scoped,
  // [DOC-1 P1-2] subjects, links, profiles
  subject: scoped,
  subjectLink: scoped,
  personProfile: scoped,
  businessProfile: scoped,
  vehicleProfile: scoped,
  // [DOC-1 P4-2]
  documentRecord: scoped,
  rectificationRequest: scoped,
  fraudCase: scoped,
};

/** Model names enrolled for tenant scoping. Derived — never hand-written. */
export const TENANT_MODEL_NAMES = Object.keys(TENANT_QUERY_EXTENSIONS);

const TENANT_MODELS = new Set<string>(TENANT_MODEL_NAMES.map((n) => n.toLowerCase()));
const SCOPED_WHERE_OPERATIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findMany', 'findFirst', 'findFirstOrThrow',
  'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert',
  'delete', 'deleteMany',
]);

const TENANT_STAMPED_UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

function stampTenant(data: unknown, tenantId: string): Record<string, unknown> {
  return { ...((data as Record<string, unknown> | undefined) ?? {}), tenantId };
}

/**
 * [TEN-01] Unscoped access to a tenant model is a DECISION, never a default.
 *  - `log` (the default): the access runs as before and is counted by model,
 *    operation and mode — the shadow that finds every unnamed caller.
 *  - `deny`: a request that has not bound a tenant, or an unbound composition
 *    root, is refused before the query; audited system work still runs.
 */
// (definition lives in lib/rls-attestation.ts so the boot assertion and the query wall read ONE rule; re-exported below)
/** [TEN-03] Bind the tenant transaction-locally on every tenant-model query
 *  (`set_config('app.current_tenant', …, true)`; system work SETs the bypass
 *  role) so the database wall binds the APP under a NOBYPASSRLS login. Off
 *  until the least-privilege login exists (runbook in TEN-03). */
// (definition lives in lib/rls-attestation.ts; re-exported below)
/** [TEN-01 · split clients] Audited system work runs on its OWN client — a
 *  login that is a member of `swift_bypass_rls` — when `SYSTEM_DATABASE_URL`
 *  is set. The request client's login must never be a member of that role
 *  (the wall's contract test refuses it), so cross-tenant work cannot be
 *  reached from a request by any SET ROLE; it is a different connection. */
let systemClient: PrismaClient | null = null;
export function systemPrismaClient(): PrismaClient | null {
  const url = process.env['SYSTEM_DATABASE_URL'];
  if (!url) return null;
  if (!systemClient) systemClient = systemConnection(new PrismaClient({ datasourceUrl: url }));
  return systemClient;
}
/** Test seam: route system work to a given client (a raw client on the system
 *  login; it receives the same guards the plugin gives its own). */
export function setSystemPrismaClient(client: PrismaClient | null): void { systemClient = client ? systemConnection(client) : null; }

/** [MASTER-019] The system connection carries the SAME guards as the request
 *  connection — the append-only evidence rule, the tenant predicate for any
 *  tenant-bound query run on it, and (in tests) the destructive guard — because
 *  a system transaction now runs every one of its queries there. */
function systemConnection(raw: PrismaClient): PrismaClient {
  return raw
    .$extends(orderStatusLogAppendOnly)
    .$extends({ name: 'tenantScope', query: SYSTEM_TENANT_QUERY_EXTENSIONS as typeof TENANT_QUERY_EXTENSIONS })
    .$extends(isTestRuntime() ? destructiveGuardExtension() : { name: 'testTargetLockInactive' }) as unknown as PrismaClient;
}

/** [MASTER-019] A system query that could only run by leaving the caller's
 *  transaction. Re-issuing it on the system client would commit it outside
 *  that transaction (it would survive a rollback and hold no lock), so it is
 *  refused and the caller's transaction rolls back instead. Start system work
 *  in its own transaction — `$transaction` under a system context opens it on
 *  the system connection. */
export class SystemWorkOutsideTransactionError extends Error {
  readonly code = 'SYSTEM_WORK_OUTSIDE_TRANSACTION';
  readonly statusCode = 500;
  constructor(model: string, operation: string) {
    super(`[MASTER-019] ${model}.${operation} is system work inside a transaction on the request connection; it cannot leave that transaction. Start the system work in its own $transaction.`);
  }
}

export class TenantContextRequiredError extends Error {
  readonly code = 'TENANT_CONTEXT_REQUIRED';
  readonly statusCode = 500;
  constructor(model: string, operation: string, mode: TenantMode) {
    super(`[TEN-01] ${model}.${operation} reached the database with no tenant bound (${mode}); bind a tenant or use runAsSystem(capability)`);
  }
}
let unscopedLogBudget = 200;

/** [L04 · R5 auto-bind] A query inside a transaction asked for a tenant other
 *  than the one the transaction was bound to when it began. The connection is
 *  bound to the first tenant, so answering would silently read nothing of the
 *  second: it is refused by name instead, and the transaction rolls back. */
export class TenantSwitchInTransactionError extends Error {
  readonly code = 'TENANT_SWITCH_IN_TRANSACTION';
  readonly statusCode = 500;
  constructor(what: string) {
    super(`[R5] ${what} asked for another tenant inside a transaction bound to one tenant; start that work in its own transaction`);
  }
}

type ScopeParams = {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (a: Record<string, unknown>) => Promise<unknown>;
  /** Prisma's request parameters; `transaction` is set when the query belongs
   *  to an interactive or batch transaction. */
  __internalParams?: { transaction?: unknown };
};
/** Which connection a scoping extension is installed on. */
type Connection = 'request' | 'system';
type BatchClient = { $transaction: (q: never[]) => Promise<unknown[]>; $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => unknown };
/** The clients one scoping extension works with: the client whose batch binds
 *  the tenant, and the system connection for system work outside a transaction. */
interface ScopeWiring { batch: () => BatchClient; system: () => PrismaClient | null }
const PROCESS_WIRING: ScopeWiring = { batch: () => prisma as unknown as BatchClient, system: () => systemPrismaClient() };

function inCallerTransaction(params: ScopeParams): boolean {
  return Boolean(params.__internalParams?.transaction);
}

function tenantScope(params: ScopeParams, connection: Connection, wiring: ScopeWiring = PROCESS_WIRING): Promise<unknown> {
  const { model, operation, args, query } = params;
  if (!model || !TENANT_MODELS.has(model.toLowerCase())) return query(args);
  const ctx = getTenantContext();
  const tenantId = ctx.tenantId;
  if (!tenantId) {
    if (ctx.mode === 'system') {
      tenantUnscopedAccessCounter.labels(model, operation, 'system', ctx.capability ?? 'unnamed').inc();
      // Already on the system connection (its own login), or binding off: run here.
      if (!rlsBindEnabled() || connection === 'system') return query(args);
      const sys = wiring.system();
      // [MASTER-019] Never re-issue a transaction's query on another connection.
      // (With no system connection the query stays where it is: on the walled
      // login it sees nothing — fail closed, inside the caller's transaction.)
      if (sys && inCallerTransaction(params)) {
        tenantBindCounter.labels('system_refused_in_tx').inc();
        return Promise.reject(new SystemWorkOutsideTransactionError(model, operation));
      }
      return onSystemClient(query, args, model, operation, sys);
    }
    tenantUnscopedAccessCounter.labels(model, operation, ctx.mode, 'none').inc();
    if (unscopedAccessPolicy() === 'deny') return Promise.reject(new TenantContextRequiredError(model, operation, ctx.mode));
    if (unscopedLogBudget > 0) { unscopedLogBudget -= 1; console.warn(`[TEN-01] unscoped ${model}.${operation} (${ctx.mode}) — no tenant bound; counted, allowed under TENANT_UNSCOPED_ACCESS=log`); }
    return query(args);
  }

  if (SCOPED_WHERE_OPERATIONS.has(operation)) {
    args['where'] = { ...((args['where'] as object) ?? {}), tenantId };
  }

  if (operation === 'create') {
    args['data'] = stampTenant(args['data'], tenantId);
  } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const data = args['data'];
    args['data'] = Array.isArray(data)
      ? data.map((row) => stampTenant(row, tenantId))
      : stampTenant(data, tenantId);
  } else if (TENANT_STAMPED_UPDATE_OPERATIONS.has(operation)) {
    args['data'] = stampTenant(args['data'], tenantId);
  } else if (operation === 'upsert') {
    args['create'] = stampTenant(args['create'], tenantId);
    args['update'] = stampTenant(args['update'], tenantId);
  }
  // The system login is not walled by the tenant setting; the predicate above
  // still confines a tenant-bound query run on it (e.g. inside a system transaction).
  if (connection === 'system') return query(args);
  if (!rlsBindEnabled()) return query(args);
  // [L04 · R5 auto-bind] Inside a transaction that began bound, the connection
  // already carries the tenant for the transaction's whole life: run here — or
  // refuse by name if this query asks for a different tenant.
  const txTenant = boundTransactionTenant(params);
  if (txTenant !== undefined) {
    if (txTenant !== tenantId) {
      tenantBindCounter.labels('tenant_switch_refused').inc();
      return Promise.reject(new TenantSwitchInTransactionError(`${model}.${operation}`));
    }
    return query(args);
  }
  return bindTenant(query, args, tenantId, wiring.batch());
}

/** [R5 review S3-1] The tenant each bound INTERACTIVE transaction was bound
 *  to, keyed by the transaction's own id — not by the async context, so a
 *  query on an outer transaction's client is judged by THAT transaction even
 *  inside a nested one begun for another tenant. Entries live exactly as long
 *  as their transaction.
 *  Assumes ONE binding client per process: transaction ids are local to a
 *  client's engine. The extended client is the only one that binds a tenant
 *  (clients derived from it with $extends share its engine; the system client
 *  never binds one). Key this by engine before adding a second binding client. */
const boundInteractiveTransactions = new Map<string, string>();
type TxRef = { kind?: string; id?: string | number };
const txRefOf = (params: { __internalParams?: { transaction?: unknown } }): TxRef | undefined =>
  params.__internalParams?.transaction as TxRef | undefined;

/** The tenant the transaction this query belongs to was bound to at BEGIN;
 *  undefined when it belongs to none (or to one begun unbound). A batch is
 *  pre-built and cannot be re-entered, so its binding rides the context. */
function boundTransactionTenant(params: { __internalParams?: { transaction?: unknown } }): string | undefined {
  const tx = txRefOf(params);
  if (!tx) return undefined;
  if (tx.kind === 'itx' && tx.id !== undefined) return boundInteractiveTransactions.get(String(tx.id));
  return tenantContext.getStore()?.batchTenant;
}

/** Marks the set_config statement of a bound query's own batch, so the
 *  transaction wrapper does not prepend a second one (review S3-2). */
const TENANT_BIND_STATEMENT = Symbol.for('swift.tenantBindStatement');
/** Prisma's interactive-transaction client carries its transaction id here.
 *  PINNED to Prisma runtime internals (checked on the locked 6.19.2): this
 *  symbol on the transaction client, and `__internalParams.transaction` as
 *  an object with `kind` ("itx" or "batch") and `id` in query extensions.
 *  Neither is public API.
 *  Both changes were simulated: a different symbol fails closed (a bound
 *  transaction "could not be identified"); a different parameter shape
 *  silently drops the refusal of a query whose transaction is bound to
 *  another tenant. Either way the transaction cases in tenant-autobind.test.ts
 *  go red, so a Prisma upgrade cannot pass CI with a changed shape. Re-check
 *  these two internals on every Prisma upgrade. */
const ITX_ID = Symbol.for('prisma.client.transaction.id');

type RawParams = { args: unknown; query: (a: unknown) => Promise<unknown>; __internalParams?: { transaction?: unknown } };
/** [L04 · R5 auto-bind] Top-level raw SQL ($queryRaw/$executeRaw) is bound
 *  exactly like a model query: under a request tenant it runs in one batch
 *  after set_config; inside a bound transaction it runs on that transaction
 *  (or is refused if it asks for another tenant). Unbound, it runs as written —
 *  on the walled login that reads nothing (fail closed). The string-built raw
 *  forms are not bound here: production source may not use them at all
 *  (sql-safety-surface.test.ts), and unbound they too read nothing. */
function rawTenantBinding(params: RawParams, wiring: ScopeWiring): Promise<unknown> {
  const { args, query } = params;
  if (!rlsBindEnabled()) return query(args);
  const ctx = getTenantContext();
  if (!ctx.tenantId) {
    // System work on a bound transaction's client would run on that tenant's
    // connection while claiming to be system work: refused by name, as a
    // model query in the same position is.
    if (boundTransactionTenant(params) !== undefined) {
      tenantBindCounter.labels('tenant_switch_refused').inc();
      return Promise.reject(new TenantSwitchInTransactionError('raw SQL (no tenant)'));
    }
    tenantBindCounter.labels(ctx.mode === 'system' ? 'raw_system' : 'raw_unbound').inc();
    return query(args);
  }
  const txTenant = boundTransactionTenant(params);
  if (txTenant !== undefined) {
    if (txTenant !== ctx.tenantId) {
      tenantBindCounter.labels('tenant_switch_refused').inc();
      return Promise.reject(new TenantSwitchInTransactionError('raw SQL'));
    }
    return query(args);
  }
  if (params.__internalParams?.transaction) return query(args); // a transaction begun unbound: unchanged
  return bindTenant(query as (a: Record<string, unknown>) => Promise<unknown>, args as Record<string, unknown>, ctx.tenantId, wiring.batch());
}
function rawTenantBindingExtension(wiring: ScopeWiring) {
  const bind = (params: RawParams) => rawTenantBinding(params, wiring);
  return { name: 'rawTenantBinding', query: { $queryRaw: bind, $executeRaw: bind } } as never;
}

/** [TEN-03] The bound query: `set_config` and the operation in ONE batch
 *  transaction, so the policy's `app.current_tenant` is this connection's
 *  for exactly this statement. Inside a caller's own interactive transaction
 *  the batch cannot be formed; the query then runs on that transaction,
 *  which must have been bound with `bindTenantTransaction` — under a
 *  NOBYPASSRLS login an unbound transaction sees ZERO rows (fail closed). */
async function bindTenant(query: (a: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>, tenantId: string, client: BatchClient): Promise<unknown> {
  try {
    const bind = client.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)` as unknown as Record<symbol, boolean>;
    bind[TENANT_BIND_STATEMENT] = true;
    const [, result] = await client.$transaction([bind as never, query(args) as never]);
    tenantBindCounter.labels('tenant').inc();
    return result;
  } catch (err) {
    if (err instanceof Error && /transaction/i.test(err.message) && /(PrismaPromise|same client|batch)/i.test(err.message)) {
      tenantBindCounter.labels('tenant_fallback_in_tx').inc();
      return query(args);
    }
    throw err;
  }
}
/** [TEN-03] System work under binding: the same operation, re-issued on the
 *  system client (its own login). Without one, the walled login runs it
 *  unbound and the database shows ZERO rows — fail closed, never a leak.
 *  [MASTER-019] Only for a query that is NOT part of a transaction: a
 *  transaction's queries never move connection (see tenantScope). */
async function onSystemClient(query: (a: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>, model: string, operation: string, sys: PrismaClient | null): Promise<unknown> {
  if (!sys) { tenantBindCounter.labels('system_no_client').inc(); return query(args); }
  tenantBindCounter.labels('system').inc();
  const delegate = (sys as unknown as Record<string, Record<string, (a: Record<string, unknown>) => Promise<unknown>>>)[model.charAt(0).toLowerCase() + model.slice(1)];
  const op = delegate?.[operation];
  if (!op) { tenantBindCounter.labels('system_no_client').inc(); return query(args); }
  return op.call(delegate, args);
}

/** [TEN-03] Bind a caller's own interactive transaction to the current
 *  context: the tenant, or the bypass role for system work. Idempotent. */
export async function bindTenantTransaction(tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }): Promise<void> {
  const ctx = getTenantContext();
  if (ctx.tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`;
  // system work has no binding on the walled login: it belongs on the system client
}

// order_status_logs is the immutable event trail behind cash disputes and claims
// (schema: "append-only by convention"). This makes it append-only in FACT: the
// only permitted operation is create. Any update / delete / upsert — from any
// route, job, or a future careless caller — throws here at ONE interception point,
// so recorded evidence can never be altered or selectively erased. Deleting the
// parent Order still cascades its logs at the DB level; that path is intentional
// (the whole order and all its evidence go together) and is not intercepted here.
const IMMUTABLE = 'order_status_logs is append-only (immutable audit evidence); update/delete is not permitted';
const denyMutation = async (): Promise<never> => {
  throw new Error(IMMUTABLE);
};

const orderStatusLogAppendOnly = {
  name: 'orderStatusLogAppendOnly',
  query: {
    orderStatusLog: {
      update: denyMutation,
      updateMany: denyMutation,
      upsert: denyMutation,
      delete: denyMutation,
      deleteMany: denyMutation,
    },
  },
};

/** [MASTER-019] The system-connection twin of TENANT_QUERY_EXTENSIONS: the same
 *  model list, scoped as the connection it is installed on. */
const SYSTEM_TENANT_QUERY_EXTENSIONS = Object.fromEntries(
  TENANT_MODEL_NAMES.map((name) => [name, { $allOperations: (params: ScopeParams) => tenantScope(params, 'system') }]),
);

/** [MASTER-019] Choose the connection when a transaction STARTS. Under binding,
 *  a callback transaction opened in a system context runs on the system
 *  connection, so every query and lock in it shares one transaction; it can no
 *  longer be split query by query between two connections. Everything else
 *  (tenant work, binding off, no system client, array transactions) opens on
 *  this client as before — and inside it a system query that would have to
 *  leave is refused (tenantScope), never committed elsewhere. */
function routeSystemTransactions<C extends object>(client: C, system: () => PrismaClient | null): C {
  type Begin = (input: unknown, options?: unknown) => Promise<unknown>;
  // The client's own $transaction, captured once: an override (or a test spy
  // wrapping it) always reaches Prisma's implementation, never itself.
  const own = (client as unknown as { $transaction: Begin }).$transaction.bind(client) as Begin;
  const begin: Begin = (input, options) => {
    const ctx = getTenantContext();
    if (typeof input === 'function' && rlsBindEnabled() && ctx.mode === 'system' && !ctx.tenantId) {
      const sys = system();
      if (sys) {
        tenantBindCounter.labels('system_tx').inc();
        return (sys as unknown as { $transaction: Begin }).$transaction(input, options);
      }
      tenantBindCounter.labels('system_no_client').inc();
    }
    // [L04 · R5 auto-bind] A transaction that BEGINS under a request tenant is
    // bound for its whole life: set_config(…, true) is the first statement on
    // its pinned connection, so every later statement — raw SQL and model
    // queries alike — sees that tenant, and the setting dies with the
    // transaction (commit or rollback), never reaching the next user of the
    // pooled connection. The tenant is recorded so a switch inside is refused.
    const tenantId = ctx.tenantId;
    // A bound query's own [set_config, query] batch is already bound.
    const ownBind = Array.isArray(input) && !!(input[0] as Record<symbol, unknown> | undefined)?.[TENANT_BIND_STATEMENT];
    if (rlsBindEnabled() && tenantId && !ownBind) {
      const current = tenantContext.getStore() ?? { tenantId, mode: 'request' as const };
      if (typeof input === 'function') {
        tenantBindCounter.labels('tenant_tx').inc();
        const fn = input as (tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }) => Promise<unknown>;
        let txId: string | undefined;
        const run = own(async (tx: Parameters<typeof fn>[0]) => {
          // Prisma's own id for this interactive transaction — the same id every
          // query on it carries. Fail closed: an unidentified transaction is not run.
          const id = (tx as unknown as Record<symbol, unknown>)[ITX_ID];
          if (id === undefined || id === null) throw new Error('[R5] a tenant-bound transaction could not be identified');
          txId = String(id);
          boundInteractiveTransactions.set(txId, tenantId);
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
          return fn(tx);
        }, options) as Promise<unknown>;
        return run.finally(() => { if (txId !== undefined) boundInteractiveTransactions.delete(txId); });
      }
      if (Array.isArray(input)) {
        tenantBindCounter.labels('tenant_tx').inc();
        const bindFirst = (client as unknown as BatchClient).$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return tenantContext.run({ ...current, batchTenant: tenantId }, async () => ((await own([bindFirst, ...input], options)) as unknown[]).slice(1));
      }
    }
    return own(input, options);
  };
  Object.defineProperty(client, '$transaction', { value: begin, writable: true, configurable: true, enumerable: false });
  // [#1444 review S3-1] A client derived with `$extends` is a NEW proxy and does
  // not carry the property above, so its transactions would open on the
  // request connection and a system transaction would be refused there. Every
  // derived client — and every client derived from it — is routed by this same
  // function: ONE `begin` decides where every transaction starts. Its system
  // transaction runs on the system connection extended the SAME way, so the
  // derived client's own extensions also apply inside that transaction.
  const ownExtends = (client as unknown as { $extends?: (...args: unknown[]) => object }).$extends?.bind(client);
  if (ownExtends) {
    const derive = (...args: unknown[]) => {
      let memo: { base: PrismaClient; derived: PrismaClient } | null = null;
      const derivedSystem = (): PrismaClient | null => {
        const sys = system();
        if (!sys) return null;
        if (!memo || memo.base !== sys) {
          memo = { base: sys, derived: (sys as unknown as { $extends: (...a: unknown[]) => PrismaClient }).$extends(...args) };
        }
        return memo.derived;
      };
      return routeSystemTransactions(ownExtends(...args), derivedSystem);
    };
    Object.defineProperty(client, '$extends', { value: derive, writable: true, configurable: true, enumerable: false });
  }
  return client;
}

const extendedPrisma = new PrismaClient({
  log: isDevelopment() ? ['query', 'warn', 'error'] : ['warn', 'error'],
  // [P1 · WS-8.3] Size the pool explicitly instead of inheriting Prisma's
  // CPU-derived default — five connections on a 2-vCPU instance. An explicit
  // `connection_limit` already in DATABASE_URL is left exactly as the operator
  // set it; see utils/db-pool.ts.
  //
  // The role is NOT hardcoded to 'api'. With `RUN_WORKERS` unset — the default
  // single-process topology — this same client also serves all 19 job
  // consumers, because server.ts hands the job runtime `app.prisma`. Sized at
  // the API budget it stayed starved for exactly the workload this fix
  // addresses. `poolRoleForApiProcess` reads the same variable server.ts reads,
  // so the two cannot disagree about which topology is running.
  datasourceUrl: resolveDatabaseUrl(process.env['DATABASE_URL'], poolRoleForApiProcess()),
}).$extends(orderStatusLogAppendOnly).$extends({
  name: 'tenantScope',
  query: TENANT_QUERY_EXTENSIONS,
}).$extends(rawTenantBindingExtension(PROCESS_WIRING))
  // [R048-001] In test mode a deleteMany/updateMany with no predicate and any
  // raw DDL are refused unless the suite granted itself the capability: cleanup
  // is namespace-owned or it does not run. Outside tests the extension is not
  // installed at all.
  .$extends(isTestRuntime() ? destructiveGuardExtension() : { name: 'testTargetLockInactive' });
const prisma = routeSystemTransactions(extendedPrisma, systemPrismaClient);
/** The process's one extended client — the plugin decorates it; tests reach it here. */
export const scopedPrisma = prisma;

/** [TEN-03] The same scoping extension for a client that connects as another
 *  role — the red test boots one under the intended NOBYPASSRLS login. The
 *  binding batches run on THAT client. [MASTER-019] It is the production
 *  scoping logic (one implementation), wired to that client and to the given
 *  system client, so a probe can never certify a rule production does not run. */
export function tenantScopeExtensionFor(client: PrismaClient, system: PrismaClient | null = null) {
  const wiring: ScopeWiring = { batch: () => client as unknown as BatchClient, system: () => system };
  return { name: 'tenantScopeProbe', query: Object.fromEntries(TENANT_MODEL_NAMES.map((n) => [n, { $allOperations: (params: ScopeParams) => tenantScope(params, 'request', wiring) }])) } as never;
}

/** [MASTER-019] The whole production client shape for an alternate login pair —
 *  request guards and scoping on `raw`, the guarded system connection on
 *  `systemRaw`, and the transaction routing between them — so the cutover
 *  topology can be exercised under real, distinct database roles. */
export function scopedClientFor(raw: PrismaClient, systemRaw: PrismaClient | null): PrismaClient {
  const system = systemRaw ? systemConnection(systemRaw) : null;
  const guarded = raw.$extends(orderStatusLogAppendOnly) as unknown as PrismaClient;
  const extended = guarded
    .$extends(tenantScopeExtensionFor(guarded, system))
    .$extends(rawTenantBindingExtension({ batch: () => guarded as unknown as BatchClient, system: () => system }))
    .$extends(isTestRuntime() ? destructiveGuardExtension() : { name: 'testTargetLockInactive' }) as unknown as PrismaClient;
  return routeSystemTransactions(extended, () => system);
}

// Re-export the tenant helpers FROM the module that owns the scoping extension.
// The extension reads the ALS via this module's single import of tenant-context;
// callers (auth, tests) that set the tenant through these re-exports are then
// guaranteed to touch the SAME AsyncLocalStorage instance the extension reads —
// immune to a test runner or bundler loading tenant-context twice.
export { enterTenant, beginRequestTenantContext, runWithTenant, runWithoutTenant, getTenantId } from './tenant-context';

// $extends changes the client's TS type but not its runtime surface (create,
// findMany, $transaction, $connect, $disconnect all remain). Consumers only need
// the PrismaClient shape, so we expose it as such — one cast at the composition
// root avoids threading the extended type through ~15 service constructors.
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app: FastifyInstance) => {
  await prisma.$connect();
  app.decorate('prisma', prisma as unknown as PrismaClient);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
