import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite installs (and removes) a fault-injection trigger on
// stock_adjustments by raw DDL — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [MASTER-025] A stock adjustment is one command: it moves stock once.
//
// The canonical movement committed first, then the adjustment record and the
// availability edges were written after the commit. A failure there answered
// 500 although the stock had already moved, and a retry moved it again. Now
// the movement, its adjustment record and the availability edges commit
// together, and a command key (Idempotency-Key) makes the adjustment record a
// durable receipt: a retry with the same key returns the committed movement
// instead of applying it twice; a new key is a new, intentional adjustment.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_610_000_000 + Math.floor(Math.random() * 300_000_000);
const run = nanoid(6).replace(/[^a-zA-Z0-9]/g, 'x').toLowerCase();
const TRIGGER = `m025_fault_${run}`;
let ownerToken = '';
let vendorId = '';
let categoryId = '';

async function makeItem(stock: number) {
  return app.prisma.item.create({ data: { vendorId, categoryId, name: `M025 ${run} ${++seq}`, basePrice: 500, isAvailable: true, stockQuantity: stock } });
}
const adjust = (itemId: string, body: Record<string, unknown>, key?: string) => app.inject({
  method: 'POST', url: `/api/v1/vendor/items/${itemId}/adjust`, payload: body,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}`, ...(key ? { 'idempotency-key': key } : {}) },
});
const stockOf = async (id: string) => (await app.prisma.item.findUniqueOrThrow({ where: { id } })).stockQuantity;
const movementsOf = (itemId: string) => app.prisma.stockMovement.findMany({ where: { itemId }, orderBy: { occurredAt: 'asc' } });
const adjustmentsOf = (itemId: string) => app.prisma.stockAdjustment.findMany({ where: { itemId }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase}`, firstName: 'Stock', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  ownerToken = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token: ownerToken, refreshToken: nanoid(48), deviceId: 'm025', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `M025 Mart ${run}`, slug: `m025-${run}`, vendorType: 'SUPERMARKET',
      phone: `+${phoneBase + 1}`, addressLine1: '1 Stock St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  categoryId = (await app.prisma.category.create({ data: { vendorId, name: 'Shelf', sortOrder: 0 } })).id;
});

afterEach(async () => {
  await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "stock_adjustments"`);
  await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
});

afterAll(async () => {
  await app.prisma.stockAdjustment.deleteMany({ where: { item: { vendorId } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[MASTER-025] a stock adjustment is one command', () => {
  it('a failure writing the adjustment record leaves the stock unmoved — the 500 is the truth — and the retry moves it once', async () => {
    const item = await makeItem(5);
    await app.prisma.$executeRawUnsafe(`CREATE FUNCTION ${TRIGGER}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected adjustment-record failure'; END $$ LANGUAGE plpgsql`);
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON "stock_adjustments" FOR EACH ROW WHEN (NEW."itemId" = '${item.id}') EXECUTE FUNCTION ${TRIGGER}()`);
    const key = `m025-fail-${nanoid(10)}`;
    const failed = await adjust(item.id, { delta: 5, reason: 'RECEIVED' }, key);
    expect(failed.statusCode).toBe(500);
    expect({ stock: await stockOf(item.id), movements: (await movementsOf(item.id)).length }).toEqual({ stock: 5, movements: 0 });

    await app.prisma.$executeRawUnsafe(`DROP TRIGGER ${TRIGGER} ON "stock_adjustments"`);
    const retry = await adjust(item.id, { delta: 5, reason: 'RECEIVED' }, key);
    expect(retry.statusCode).toBe(200);
    expect(await stockOf(item.id)).toBe(10);
    expect(await movementsOf(item.id)).toHaveLength(1);
    expect(await adjustmentsOf(item.id)).toHaveLength(1);
  });

  it('a lost response retried with the same key returns the committed movement and does not move stock again', async () => {
    const item = await makeItem(5);
    const key = `m025-lost-${nanoid(10)}`;
    const first = await adjust(item.id, { delta: 5, reason: 'RECEIVED', note: 'pallet 7' }, key);
    expect(first.statusCode).toBe(200);
    const again = await adjust(item.id, { delta: 5, reason: 'RECEIVED', note: 'pallet 7' }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.adjustment.id).toBe(first.json().data.adjustment.id);
    expect(again.json().data.movementId).toBe(first.json().data.movementId);
    expect(again.json().data.replayed).toBe(true);
    expect(await stockOf(item.id)).toBe(10);
    expect(await movementsOf(item.id)).toHaveLength(1);

    // a NEW key is a new, intentional adjustment
    const second = await adjust(item.id, { delta: 5, reason: 'RECEIVED', note: 'pallet 8' }, `m025-new-${nanoid(10)}`);
    expect(second.statusCode).toBe(200);
    expect(await stockOf(item.id)).toBe(15);
    expect(await movementsOf(item.id)).toHaveLength(2);
  });

  it('the same key with a different adjustment is refused and changes nothing', async () => {
    const item = await makeItem(5);
    const key = `m025-reuse-${nanoid(10)}`;
    expect((await adjust(item.id, { delta: 2, reason: 'RECEIVED' }, key)).statusCode).toBe(200);
    for (const body of [{ delta: 3, reason: 'RECEIVED' }, { delta: 2, reason: 'DAMAGED' }, { delta: 2, reason: 'RECEIVED', note: 'other' }]) {
      const res = await adjust(item.id, body, key);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await stockOf(item.id)).toBe(7);
    expect(await movementsOf(item.id)).toHaveLength(1);
  });

  it('two simultaneous submissions of one command move stock once and both answer with the same receipt', async () => {
    const item = await makeItem(5);
    const key = `m025-race-${nanoid(10)}`;
    // A barrier on the receipt look-up: BOTH submissions pass the "already
    // committed?" check before either commits, so the race is real — the loser
    // must be settled by the receipt's unique key inside the transaction.
    const real = app.prisma.stockAdjustment.findUnique.bind(app.prisma.stockAdjustment);
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(app.prisma.stockAdjustment, 'findUnique').mockImplementation((async (args: never) => {
      arrived += 1;
      if (arrived <= 2) {
        if (arrived === 2) release();
        await bothArrived;
      }
      return real(args);
    }) as never);
    let a; let b;
    try {
      [a, b] = await Promise.all([adjust(item.id, { delta: 4, reason: 'RECEIVED' }, key), adjust(item.id, { delta: 4, reason: 'RECEIVED' }, key)]);
    } finally {
      spy.mockRestore();
    }
    expect(arrived).toBeGreaterThanOrEqual(3);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().data.replayed, b.json().data.replayed].sort()).toEqual([false, true]);
    expect(a.json().data.adjustment.id).toBe(b.json().data.adjustment.id);
    expect(await stockOf(item.id)).toBe(9);
    expect(await movementsOf(item.id)).toHaveLength(1);
  });

  it('movement, adjustment and availability reconcile, and the hide/unhide edges commit with the movement', async () => {
    const item = await makeItem(3);
    const down = await adjust(item.id, { delta: -3, reason: 'DAMAGED' }, `m025-down-${nanoid(10)}`);
    expect(down.json().data).toMatchObject({ stockQuantity: 0, isAvailable: false });
    const up = await adjust(item.id, { delta: 6, reason: 'RECEIVED' }, `m025-up-${nanoid(10)}`);
    expect(up.json().data).toMatchObject({ stockQuantity: 6, isAvailable: true });
    const movements = await movementsOf(item.id);
    const adjustments = await adjustmentsOf(item.id);
    expect(movements.map((m) => m.delta)).toEqual(adjustments.map((a) => a.delta));
    expect(movements.at(-1)!.balanceAfter).toBe(await stockOf(item.id));
    expect(up.json().data.movementId).toBe(movements.at(-1)!.id);
  });

  it('without a key the adjustment still commits as one unit (old clients keep working)', async () => {
    const item = await makeItem(1);
    const res = await adjust(item.id, { delta: 2, reason: 'RECEIVED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.stockQuantity).toBe(3);
    expect((await adjust(item.id, { delta: -9, reason: 'DAMAGED' })).statusCode).toBe(409);
    expect(await stockOf(item.id)).toBe(3);
    expect(await adjustmentsOf(item.id)).toHaveLength(1);
  });
});
