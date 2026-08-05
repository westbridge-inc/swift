import { PrismaClient } from '@prisma/client';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { getTenantId } from './tenant-context';

// Multi-tenancy stage 2 — tenant scoping at the ORM layer. When a request has
// bound a tenant (tenant-context), tenant-owned models are filtered to it so a
// LIST/COUNT can never span tenants, and CREATE stamps the tenant. Only the
// filter-shaped operations are auto-scoped: findUnique/update/delete take a
// UNIQUE where and can't carry an extra tenantId column — those stay isolated
// by the existing per-owner scoping (customerId / ownerId / userId), which the
// IDOR suite proves. No context set (jobs, tests, pre-auth) → unscoped, so
// single-tenant behavior is unchanged.
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
  sosAlert: scoped, emergencyContact: scoped, tripShareToken: scoped, tripSafetySession: scoped,
  livenessCheck: scoped, incidentCase: scoped, evidenceBundle: scoped, safetyAccessLog: scoped,
  // Money: settlement, receipts, the agent-cash rail, trials.
  mmgAgentPayment: scoped, settlementBatch: scoped, feeReceipt: scoped, receiptCounter: scoped,
  sanTombstone: scoped, tenantBillingCurrency: scoped, trialGrant: scoped,
  // Ads platform.
  advertiser: scoped, adPlacement: scoped, adCampaign: scoped, adInvoice: scoped,
  adEvent: scoped, houseAd: scoped, adsSettings: scoped, adsAuditLog: scoped,
  // Ratings.
  actorRatingStat: scoped, ratingReport: scoped, itemFeedback: scoped, ratingTagDef: scoped,
  // Growth / QR attribution.
  slugRedirect: scoped, pendingAttribution: scoped, attributionClaim: scoped, scanDailyRollup: scoped,
  // Batching + scheduling.
  deliveryRun: scoped, batchEvaluation: scoped, batchingSettings: scoped, bookingException: scoped,
};

/** Model names enrolled for tenant scoping. Derived — never hand-written. */
export const TENANT_MODEL_NAMES = Object.keys(TENANT_QUERY_EXTENSIONS);

const TENANT_MODELS = new Set<string>(TENANT_MODEL_NAMES.map((n) => n.toLowerCase()));
const SCOPED_READS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany',
]);

function tenantScope({ model, operation, args, query }: {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (a: Record<string, unknown>) => Promise<unknown>;
}): Promise<unknown> {
  const tenantId = getTenantId();
  if (!tenantId || !model || !TENANT_MODELS.has(model.toLowerCase())) return query(args);

  if (SCOPED_READS.has(operation)) {
    args['where'] = { ...((args['where'] as object) ?? {}), tenantId };
  } else if (operation === 'create') {
    args['data'] = { tenantId, ...((args['data'] as object) ?? {}) };
  } else if (operation === 'createMany') {
    const data = args['data'];
    const stamp = (row: object) => ({ tenantId, ...row });
    args['data'] = Array.isArray(data) ? data.map(stamp) : stamp((data as object) ?? {});
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
  log: process.env['NODE_ENV'] === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
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
