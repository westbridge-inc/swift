import { PrismaClient } from '@prisma/client';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { getTenantId } from './tenant-context';
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
const scoped = { $allOperations: tenantScope };

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
  sosAlert: scoped, emergencyContact: scoped, tripShareToken: scoped, tripSafetySession: scoped,
  livenessCheck: scoped, incidentCase: scoped, evidenceBundle: scoped, safetyAccessLog: scoped,
  // Money: settlement, receipts, the agent-cash rail, trials.
  mmgAgentPayment: scoped, settlementBatch: scoped, feeReceipt: scoped, receiptCounter: scoped,
  // [M-20] A settlement file as one staged, validated import.
  settlementImport: scoped,
  // [M-18] The provider-transaction identity behind every agent-cash observation.
  providerPayment: scoped,
  tenantBillingCurrency: scoped, trialGrant: scoped,
  // [M-08] The prepaid top-up as one persisted command.
  topUpCommand: scoped,
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
  // [REPORT-014 F-014-03] Supply watches are tenant rows: demand counts and
  // recovery notifications must never see another operator's watchers.
  supplyWatch: scoped,
  // [F-026-02] The storage-deletion census carries tenant rows (a selfie key
  // belongs to its user's tenant); the opportunistic retry therefore works
  // within the acting tenant — the obligation is discharged per tenant.
  storageOrphan: scoped,
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

function tenantScope({ model, operation, args, query }: {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (a: Record<string, unknown>) => Promise<unknown>;
}): Promise<unknown> {
  const tenantId = getTenantId();
  if (!tenantId || !model || !TENANT_MODELS.has(model.toLowerCase())) return query(args);

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
  return query(args);
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

const prisma = new PrismaClient({
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
}).$extends({
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
}).$extends({
  name: 'tenantScope',
  query: TENANT_QUERY_EXTENSIONS,
});

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
