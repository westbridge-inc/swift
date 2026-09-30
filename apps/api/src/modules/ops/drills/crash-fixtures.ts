import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { runAsSystem, runWithTenant } from '../../../plugins/tenant-context';
import { assertTenantWall, attestationOf, readRlsFacts } from '../../../lib/rls-attestation';
import { drillMarker, ensureAccount, fixtureTransaction, validateRunId, DrillFixtureError } from './fixtures';
import type { DrillTarget } from './guard';

// The runner deliberately has no database dependency. These shapes match its
// crash-scope.ts parser, exercised by the fixture-to-runner contract test.
interface Actor { userId: string; phone: string }
export interface CrashScope {
  version: 1; runId: string; tenantId: string;
  target: { deploymentId: string; environment: string; database: string };
  admin: Actor; customer: Actor; storeOwner: Actor;
  riders: Array<Actor & { riderId: string }>;
  store: { vendorId: string; itemId: string };
}
const keyFor = (runId: string) => `crash-${createHash('sha256').update(validateRunId(runId)).digest('hex').slice(0, 32)}`;
export const crashTenantId = (runId: string) => `drill-${keyFor(runId)}`;
const tenantName = (runId: string) => `DRILL crash ${validateRunId(runId)} (synthetic)`;
const refused = (why: string): never => { throw new DrillFixtureError('CRASH_ISOLATION_REQUIRED', why); };

async function readLocked(db: PrismaClient, runId: string, target: DrillTarget): Promise<CrashScope> {
  const tenantId = crashTenantId(runId);
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  const scope = (tenant?.config as unknown as { crashDrill?: CrashScope })?.crashDrill;
  if (!tenant || tenant.kind !== 'CRAWLER' || tenant.slug !== tenantId || tenant.name !== tenantName(runId)
      || !tenant.purgeProtected || !tenant.isActive || scope?.version !== 1 || scope?.runId !== runId || scope.tenantId !== tenantId
      || scope.target.deploymentId !== target.deploymentId || scope.target.environment !== target.environment
      || scope.target.database !== target.database) return refused('the protected run tenant and its creation record are required');
  const actors = [scope.admin, scope.customer, scope.storeOwner, ...scope.riders];
  const users = await db.user.findMany({ where: { tenantId }, select: { id: true, phone: true, syntheticRunId: true, isSynthetic: true } });
  if (actors.length !== 6 || new Set(actors.map((a) => a.userId)).size !== 6 || users.length !== 6
      || users.some((u) => u.syntheticRunId !== drillMarker(keyFor(runId)) || !u.isSynthetic || !actors.some((a) => a.userId === u.id && a.phone === u.phone))) {
    return refused('the tenant must contain exactly this run’s six synthetic actors');
  }
  const riders = await db.rider.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { id: true, userId: true } });
  if (riders.length !== 3 || riders.some((r) => !scope.riders.some((a) => a.riderId === r.id && a.userId === r.userId))) return refused('the tenant rider profiles must be exactly the three run riders');
  const store = await db.vendor.findUnique({ where: { id: scope.store.vendorId }, include: { owner: true } });
  const item = await db.item.findUnique({ where: { id: scope.store.itemId } });
  if (store?.tenantId !== tenantId || store.owner.userId !== scope.storeOwner.userId || item?.vendorId !== store.id) return refused('the store and item must belong to the isolated run');
  return scope;
}

/** Read-only attestation for the host, including before setup and after restart.
 * Isolation survives process failure because dispatch always uses order.tenantId;
 * none of the public signup/activation routes admit an outside account here. */
export async function readCrashFixtures(db: PrismaClient, runId: string, target: DrillTarget): Promise<CrashScope> {
  return fixtureTransaction(db, (tx) => readLocked(tx, runId, target), crashTenantId(runId));
}

/** Six synthetic actors in a fresh, non-public tenant. This is fixture setup,
 * not evidence that any human passed verification. No consent or billing rows
 * are manufactured. The pre-checklist fixture flags permit the real HTTP GO
 * path, which still owns sessions, live location, authority and dispatch. */
export async function createCrashFixtures(client: PrismaClient, runId: string, target: DrillTarget, wallDb: PrismaClient = client): Promise<CrashScope> {
  const tenantId = crashTenantId(runId);
  return fixtureTransaction(client, async (db) => {
    const existing = await db.tenant.findUnique({ where: { id: tenantId } });
    if (existing) return readLocked(db, runId, target);
    const activeAfter = await db.tenant.count({ where: { isActive: true } }) + 1;
    assertTenantWall(attestationOf(await readRlsFacts(wallDb)), activeAfter);
    await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: tenantName(runId), kind: 'CRAWLER', purgeProtected: true, isActive: true } });
    return runWithTenant(tenantId, async () => {
      const key = keyFor(runId);
      const admin = await ensureAccount(db, key, { slot: 'admin', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' });
      await db.admin.create({ data: { userId: admin.userId, permissions: ['*'] } });
      const customer = await ensureAccount(db, key, { slot: 'customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' });
      const storeOwner = await ensureAccount(db, key, { slot: 'store', roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', vendorOwner: true });
      const riders: CrashScope['riders'] = [];
      for (const slot of ['DR1', 'DR2', 'DR3']) {
        const actor = await ensureAccount(db, key, { slot, roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER' });
        await db.user.update({ where: { id: actor.userId }, data: { selfieCapturedAt: new Date() } });
        const rider = await db.rider.create({ data: { userId: actor.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000 }, select: { id: true } });
        riders.push({ userId: actor.userId, phone: actor.phone, riderId: rider.id });
      }
      const owner = await db.vendorOwner.findUniqueOrThrow({ where: { userId: storeOwner.userId } });
      const store = await db.vendor.create({ data: { tenantId, ownerId: owner.id, slug: tenantId, name: tenantName(runId), vendorType: 'RESTAURANT', phone: storeOwner.phone, addressLine1: '2 Synthetic Drill Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true } });
      const category = await db.category.create({ data: { vendorId: store.id, name: 'Menu' } });
      const item = await db.item.create({ data: { vendorId: store.id, categoryId: category.id, name: 'R1 Plate', basePrice: 1500, isAvailable: true } });
      const actorOnly = ({ userId, phone }: Actor): Actor => ({ userId, phone });
      const scope: CrashScope = { version: 1, runId, tenantId, target: { deploymentId: target.deploymentId, environment: target.environment, database: target.database }, admin: actorOnly(admin), customer: actorOnly(customer), storeOwner: actorOnly(storeOwner), riders, store: { vendorId: store.id, itemId: item.id } };
      await db.tenant.update({ where: { id: tenantId }, data: { config: { crashDrill: scope } as unknown as Prisma.InputJsonObject } });
      return runAsSystem('staging-drill-crash-fixtures', () => readLocked(db, runId, target));
    });
  }, tenantId);
}

/** Retire an isolated fixture only after every order is terminal. A failed
 * setup/handback keeps the protected tenant and its actors, so queued recovery
 * continues inside the same boundary. Restrict failures roll back all deletes. */
export async function cleanupCrashFixtures(client: PrismaClient, runId: string, target: DrillTarget) {
  const tenantId = crashTenantId(runId);
  return fixtureTransaction(client, async (db) => {
    if (!await db.tenant.findUnique({ where: { id: tenantId } })) return { runId, tenant: 'absent', kept: [] };
    const scope = await readLocked(db, runId, target);
    const ids = [scope.admin, scope.customer, scope.storeOwner, ...scope.riders].map((a) => a.userId);
    await db.$queryRaw`SELECT id FROM users WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM vendors WHERE id = ${scope.store.vendorId} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM riders WHERE "userId" = ANY(${ids}) ORDER BY id FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM orders WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
    await readLocked(db, runId, target);
    const orders = await db.order.findMany({ where: { tenantId }, select: { id: true, status: true, customerId: true, vendorId: true } });
    if (orders.some((o) => o.customerId !== scope.customer.userId || o.vendorId !== scope.store.vendorId)) return refused('an order does not belong to the run customer and store');
    const live = orders.filter((o) => !['DELIVERED', 'COMPLETED', 'CANCELLED', 'FAILED'].includes(o.status));
    if (live.length) return { runId, tenant: 'kept', kept: [`${live.length} nonterminal order(s); isolated actors retained for recovery`] };
    await db.cart.deleteMany({ where: { customerId: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await db.vendor.delete({ where: { id: scope.store.vendorId } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.tenant.update({ where: { id: tenantId }, data: { purgeProtected: false } });
    await db.tenant.delete({ where: { id: tenantId } });
    return { runId, tenant: 'removed', kept: [], removed: { users: ids.length, orders: orders.length, stores: 1 } };
  }, tenantId);
}
