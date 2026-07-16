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
const TENANT_MODELS = new Set(['user', 'vendor', 'order']);
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
  query: {
    user: { $allOperations: tenantScope },
    vendor: { $allOperations: tenantScope },
    order: { $allOperations: tenantScope },
  },
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
