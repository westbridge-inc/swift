import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { NotificationService } from '../modules/notification/notification.service';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [IN-STORE-SALE · owner 27 Oct] "Sold in store −1": a store with no till system sells an item at the counter and
// takes it off its Swift stock in ONE tap, so the next app order never sells the one that is gone.
//
// Graded over a real socket (the request leaves the process, as a phone's does). One tap = one sale, through the
// same single writer as a checkout sale: never below 0 (plain words), hidden at 0, the owner alerted on the crossing
// edge, a ledger row with its balanceAfter. The tap's key makes a retry of the SAME tap a replay; a new tap is a new
// sale. Undo is a compensating ledger row (the ledger is append-only), once per sale. Only the caller's own store.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NONE_LEFT = "You have 0 of this left on Swift. Update the stock if that's wrong.";
const UNTRACKED = "Stock isn't counted for this item. Add a stock number to track it.";
let app: FastifyInstance;
let base = '';
const run = wordFreeTag(8);
let seq = 0;
const userIds: string[] = [];
const vendorIds: string[] = [];
const tokens: Record<'owner' | 'staff' | 'otherOwner' | 'otherStaff' | 'customer', string> = { owner: '', staff: '', otherOwner: '', otherStaff: '', customer: '' };
let vendorId = '';
let categoryId = '';
let ownerUserId = '';
const lowStock = vi.spyOn(NotificationService.prototype, 'lowStock').mockResolvedValue(undefined);

/** Staff are customers with a store membership (there is no staff account role). */
async function makeUser(role: 'VENDOR_OWNER' | 'CUSTOMER') {
  const user = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Sale', lastName: 'Tester', roles: [role], activeRole: role, isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `iss-${seq++}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { user, token };
}
async function makeStore(ownerUser: string, name: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `${name} ${run}`, slug: `iss-${name.toLowerCase()}-${run}`, vendorType: 'SUPERMARKET',
      phone: testPhone(), addressLine1: '1 Counter St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } });
  return { vendorId: vendor.id, categoryId: category.id };
}
async function makeItem(stock: number | null, extra: { lowStockThreshold?: number; isAvailable?: boolean; inVendor?: string; inCategory?: string } = {}) {
  return app.prisma.item.create({
    data: {
      vendorId: extra.inVendor ?? vendorId, categoryId: extra.inCategory ?? categoryId, name: `Counter ${run} ${++seq}`, basePrice: 500,
      isAvailable: extra.isAvailable ?? true, stockQuantity: stock, lowStockThreshold: extra.lowStockThreshold ?? null,
    },
  });
}
/** Over the socket, as the app sends it. */
async function call(path: string, who: keyof typeof tokens, init: { key?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/api/v1/vendor${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}`, ...(init.key ? { 'idempotency-key': init.key } : {}) },
    body: JSON.stringify(init.body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown>; error?: { code?: string; message?: string } } };
}
const sell = (itemId: string, key: string, who: keyof typeof tokens = 'owner') => call(`/items/${itemId}/in-store-sale`, who, { key });
const undo = (itemId: string, saleKey: string, who: keyof typeof tokens = 'owner') => call(`/items/${itemId}/in-store-sale/undo`, who, { body: { saleKey } });
const tapKey = () => `tap-${nanoid(12).replace(/[^A-Za-z0-9]/g, '0')}`;
const itemOf = (id: string) => app.prisma.item.findUniqueOrThrow({ where: { id }, select: { stockQuantity: true, isAvailable: true, autoHiddenAt: true } });
const ledgerOf = (itemId: string) => app.prisma.stockMovement.findMany({ where: { itemId }, orderBy: { occurredAt: 'asc' } });
const receiptsOf = (itemId: string) => app.prisma.stockAdjustment.findMany({ where: { itemId }, orderBy: { createdAt: 'asc' } });

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
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const owner = await makeUser('VENDOR_OWNER');
  ownerUserId = owner.user.id;
  tokens.owner = owner.token;
  ({ vendorId, categoryId } = await makeStore(owner.user.id, 'Corner'));
  const staff = await makeUser('CUSTOMER');
  tokens.staff = staff.token;
  await app.prisma.vendorStaff.create({ data: { vendorId, userId: staff.user.id, role: 'STAFF', invitedBy: owner.user.id } });

  const otherOwner = await makeUser('VENDOR_OWNER');
  tokens.otherOwner = otherOwner.token;
  const other = await makeStore(otherOwner.user.id, 'Across');
  const otherStaff = await makeUser('CUSTOMER');
  tokens.otherStaff = otherStaff.token;
  await app.prisma.vendorStaff.create({ data: { vendorId: other.vendorId, userId: otherStaff.user.id, role: 'MANAGER', invitedBy: otherOwner.user.id } });
  tokens.customer = (await makeUser('CUSTOMER')).token;
});

afterEach(() => { lowStock.mockClear(); });

afterAll(async () => {
  // The ledger is append-only and outlives its items by design: only the items and their receipts go.
  await app.prisma.stockAdjustment.deleteMany({ where: { item: { vendorId: { in: vendorIds } } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  lowStock.mockRestore();
});

describe('[IN-STORE-SALE] one tap takes one sold-in-person item off the Swift stock', () => {
  it('a tap takes one, through the ledger: an IN_STORE_SALE row of -1 with its balanceAfter, and its receipt', async () => {
    const item = await makeItem(5);
    const key = tapKey();
    const res = await sell(item.id, key);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ stockQuantity: 4, isAvailable: true, replayed: false });
    expect(await itemOf(item.id)).toMatchObject({ stockQuantity: 4, isAvailable: true, autoHiddenAt: null });
    const ledger = await ledgerOf(item.id);
    expect(ledger.map((m) => ({ delta: m.delta, balanceAfter: m.balanceAfter, reason: m.reason, actorId: m.actorId, orderId: m.orderId })))
      .toEqual([{ delta: -1, balanceAfter: 4, reason: 'IN_STORE_SALE', actorId: ownerUserId, orderId: null }]);
    expect(res.json.data?.movementId).toBe(ledger[0].id);
    const receipts = await receiptsOf(item.id);
    expect(receipts.map((r) => ({ delta: r.delta, reason: r.reason, commandKey: r.commandKey, movementId: r.movementId })))
      .toEqual([{ delta: -1, reason: 'IN_STORE_SALE', commandKey: key, movementId: ledger[0].id }]);
  });

  it('a retry of the SAME tap (a lost answer, a double submit at once) takes one, never two', async () => {
    const item = await makeItem(5);
    const key = tapKey();
    const first = await sell(item.id, key);
    const again = await sell(item.id, key);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.json.data).toMatchObject({ stockQuantity: 4, replayed: true, movementId: first.json.data?.movementId });
    // A separate tap, and one tap submitted twice at the same moment, race each other.
    const doubled = tapKey();
    const raced = await Promise.all([sell(item.id, tapKey()), sell(item.id, doubled), sell(item.id, doubled)]);
    expect(raced.map((r) => r.status)).toEqual([200, 200, 200]);
    // 5 - the first tap - the separate tap - ONE for the doubled tap = 2.
    expect((await itemOf(item.id)).stockQuantity).toBe(2);
    expect(await ledgerOf(item.id)).toHaveLength(3);
    expect(await receiptsOf(item.id)).toHaveLength(3);
  });

  it('two separate taps take two', async () => {
    const item = await makeItem(5);
    expect((await sell(item.id, tapKey())).status).toBe(200);
    const second = await sell(item.id, tapKey());
    expect(second.status).toBe(200);
    expect(second.json.data?.stockQuantity).toBe(3);
    expect((await ledgerOf(item.id)).map((m) => m.balanceAfter)).toEqual([4, 3]);
  });

  it('never below 0: the last one hides the item as a checkout sale does; the next tap is refused in plain words', async () => {
    const item = await makeItem(1);
    const lastKey = tapKey();
    const last = await sell(item.id, lastKey);
    expect(last.status).toBe(200);
    expect(last.json.data).toMatchObject({ stockQuantity: 0, isAvailable: false });
    const hidden = await itemOf(item.id);
    expect(hidden).toMatchObject({ stockQuantity: 0, isAvailable: false });
    expect(hidden.autoHiddenAt).toBeInstanceOf(Date);

    const refused = await sell(item.id, tapKey());
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'NONE_LEFT', message: NONE_LEFT });
    expect((await itemOf(item.id)).stockQuantity).toBe(0);
    expect(await ledgerOf(item.id)).toHaveLength(1);
    expect(await receiptsOf(item.id)).toHaveLength(1);

    // The retry of the tap that took the last one answers with its receipt, never "0 left".
    const replay = await sell(item.id, lastKey);
    expect(replay.status).toBe(200);
    expect(replay.json.data).toMatchObject({ replayed: true, stockQuantity: 0 });
  });

  it('the owner is alerted as a checkout alerts: sold out at 0, low stock once on the crossing edge', async () => {
    const item = await makeItem(4, { lowStockThreshold: 3 });
    await sell(item.id, tapKey()); // 4 -> 3: crosses the level
    await vi.waitFor(() => expect(lowStock).toHaveBeenCalledTimes(1));
    expect(lowStock).toHaveBeenLastCalledWith(ownerUserId, { itemId: item.id, name: item.name, remaining: 3, kind: 'low' });
    await sell(item.id, tapKey()); // 3 -> 2: already below, no second alert
    await sell(item.id, tapKey()); // 2 -> 1
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lowStock).toHaveBeenCalledTimes(1);
    await sell(item.id, tapKey()); // 1 -> 0: sold out
    await vi.waitFor(() => expect(lowStock).toHaveBeenCalledTimes(2));
    expect(lowStock).toHaveBeenLastCalledWith(ownerUserId, { itemId: item.id, name: item.name, remaining: 0, kind: 'out' });
  });

  it('a replayed tap alerts nobody again', async () => {
    const item = await makeItem(1);
    const key = tapKey();
    await sell(item.id, key);
    await vi.waitFor(() => expect(lowStock).toHaveBeenCalledTimes(1));
    await sell(item.id, key);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lowStock).toHaveBeenCalledTimes(1);
  });

  it('Undo puts the one back with a NEW compensating row (no row edited), once per sale, and shows the item again only when that sale hid it', async () => {
    const item = await makeItem(1);
    const key = tapKey();
    await sell(item.id, key);
    const before = await ledgerOf(item.id);
    const undone = await undo(item.id, key);
    expect(undone.status).toBe(200);
    expect(undone.json.data).toMatchObject({ stockQuantity: 1, isAvailable: true, replayed: false });
    expect(await itemOf(item.id)).toMatchObject({ stockQuantity: 1, isAvailable: true, autoHiddenAt: null });
    const ledger = await ledgerOf(item.id);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toEqual(before[0]); // the sale's row is untouched
    expect({ delta: ledger[1].delta, balanceAfter: ledger[1].balanceAfter, reason: ledger[1].reason, actorId: ledger[1].actorId })
      .toEqual({ delta: 1, balanceAfter: 1, reason: 'IN_STORE_SALE', actorId: ownerUserId });
    expect(ledger[1].note).toContain(before[0].id);

    // A retry of the Undo (or a second Undo of the same sale) puts nothing more back.
    const again = await undo(item.id, key);
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ replayed: true, stockQuantity: 1 });
    const twice = await Promise.all([undo(item.id, key), undo(item.id, key)]);
    expect(twice.map((r) => r.status)).toEqual([200, 200]);
    expect((await itemOf(item.id)).stockQuantity).toBe(1);
    expect(await ledgerOf(item.id)).toHaveLength(2);
    // The ledger explains the counter: the starting 1 plus every row's delta (the sale and its Undo net to 0).
    const rows = await ledgerOf(item.id);
    expect(rows.reduce((sum, m) => sum + m.delta, 1)).toBe((await itemOf(item.id)).stockQuantity);
    expect(rows.at(-1)!.balanceAfter).toBe((await itemOf(item.id)).stockQuantity);
  });

  it('Undo never shows an item the store hid by hand, nor one a different event hid', async () => {
    // Hidden by hand before the sale: it stays hidden after the Undo.
    const byHand = await makeItem(1, { isAvailable: false });
    const k1 = tapKey();
    expect((await sell(byHand.id, k1)).status).toBe(200);
    expect((await undo(byHand.id, k1)).json.data).toMatchObject({ stockQuantity: 1, isAvailable: false });

    // Two taps: the second emptied the shelf and hid it. Undoing the FIRST leaves the second's hide in place.
    const two = await makeItem(2);
    const first = tapKey();
    const second = tapKey();
    await sell(two.id, first);
    await sell(two.id, second);
    expect((await itemOf(two.id)).isAvailable).toBe(false);
    expect((await undo(two.id, first)).json.data).toMatchObject({ stockQuantity: 1, isAvailable: false });
    // Undoing the one that hid it shows it again.
    expect((await undo(two.id, second)).json.data).toMatchObject({ stockQuantity: 2, isAvailable: true });
  });

  it('an item whose stock is not counted is refused in plain words, and nothing is written', async () => {
    const item = await makeItem(null);
    const res = await sell(item.id, tapKey());
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'UNTRACKED', message: UNTRACKED });
    expect(await ledgerOf(item.id)).toHaveLength(0);
    expect(await receiptsOf(item.id)).toHaveLength(0);
    expect((await itemOf(item.id)).stockQuantity).toBeNull();
  });

  it('only the store: another store\'s owner or manager, and a customer, cannot touch it; the store\'s own staff can, as with Adjust stock', async () => {
    const item = await makeItem(5);
    for (const who of ['otherOwner', 'otherStaff'] as const) {
      const res = await sell(item.id, tapKey(), who);
      expect(res.status).toBe(404);
    }
    expect((await sell(item.id, tapKey(), 'customer')).status).toBe(403);
    expect((await itemOf(item.id)).stockQuantity).toBe(5);
    expect(await ledgerOf(item.id)).toHaveLength(0);

    const staffKey = tapKey();
    const byStaff = await sell(item.id, staffKey, 'staff');
    expect(byStaff.status).toBe(200);
    expect(byStaff.json.data?.stockQuantity).toBe(4);
    // Nobody else can undo it, not even the owner: only the person who recorded the sale.
    for (const who of ['owner', 'otherOwner'] as const) expect((await undo(item.id, staffKey, who)).status).toBe(404);
    expect((await undo(item.id, staffKey, 'staff')).status).toBe(200);
    expect((await itemOf(item.id)).stockQuantity).toBe(5);
  });

  it('Undo is only for an in-store sale on that item: an unknown key, a stock adjustment, or another item\'s sale is refused', async () => {
    const item = await makeItem(5);
    const otherItem = await makeItem(5);
    const k = tapKey();
    await sell(otherItem.id, k);
    expect((await undo(item.id, k)).status).toBe(404);
    expect((await undo(item.id, tapKey())).json.error?.code).toBe('SALE_NOT_FOUND');
    const adjustKey = tapKey();
    const adjusted = await fetch(`${base}/api/v1/vendor/items/${item.id}/adjust`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.owner}`, 'idempotency-key': adjustKey },
      body: JSON.stringify({ delta: -1, reason: 'MANUAL' }),
    });
    expect(adjusted.status).toBe(200);
    expect((await undo(item.id, adjustKey)).status).toBe(404);
    expect((await itemOf(item.id)).stockQuantity).toBe(4);
  });

  it('each tap must carry its own key from the plain alphabet; a key that named another change is refused', async () => {
    const item = await makeItem(5);
    expect((await sell(item.id, '')).status).toBe(400);
    expect((await call(`/items/${item.id}/in-store-sale`, 'owner')).json.error?.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect((await sell(item.id, 'undo:abcdefgh')).status).toBe(400);
    const adjustKey = tapKey();
    await fetch(`${base}/api/v1/vendor/items/${item.id}/adjust`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.owner}`, 'idempotency-key': adjustKey },
      body: JSON.stringify({ delta: 2, reason: 'RECEIVED' }),
    });
    const reused = await sell(item.id, adjustKey);
    expect(reused.status).toBe(409);
    expect(reused.json.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await itemOf(item.id)).stockQuantity).toBe(7);
  });

  it('the stock adjust route (builds 9-12) still takes exactly its five reasons: IN_STORE_SALE is not one of them', async () => {
    const item = await makeItem(5);
    const res = await fetch(`${base}/api/v1/vendor/items/${item.id}/adjust`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.owner}`, 'idempotency-key': tapKey() },
      body: JSON.stringify({ delta: -1, reason: 'IN_STORE_SALE' }),
    });
    expect(res.status).toBe(400);
    for (const reason of ['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN']) {
      const ok = await fetch(`${base}/api/v1/vendor/items/${item.id}/adjust`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.owner}`, 'idempotency-key': tapKey() },
        body: JSON.stringify({ delta: 1, reason }),
      });
      expect(ok.status).toBe(200);
    }
    expect((await itemOf(item.id)).stockQuantity).toBe(10);
  });
});
