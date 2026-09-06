/**
 * [DOC-1 §31.4 · DOC-INV-47 · P31-1] test_no_rlp_payout_without_evidence
 *
 * Rider Loss Protection is a POLICY, not a sentence: the covered amount is what the
 * rider fronted (the food cost, never the delivery fee) and is capped at the ID gate;
 * a rolling 30-day cap and a review threshold route claims to a person; a suspended
 * protection is stated, audited and told, never silent; every payout is drawn from a
 * named, funded reserve line or refused; and — the invariant — nobody is paid without
 * a complete evidence bundle assembled from the artefacts the platform already holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { CashRulesService, DEFAULT_CASH_RULES } from '../modules/cash/cash-rules.service';
import {
  LOSS_PROTECTION_DEFAULTS, LOSS_PROTECTION_FLAGS, assembleClaimEvidence, provisionReserveForPreviousMonth, reserveBalance,
  rlpReserveDdl, sweepLossProtection,
} from '../modules/cash/rlp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const HOUR = 3_600_000;
const DOOR = { lat: 6.8123, lng: -58.1601 };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-rlp-test');
/** A country nobody else uses: the reserve ledger is per country, so this suite owns its own line. */
const COUNTRY = 'GY';

let app: FastifyInstance;
let notifications: NotificationService;
let cash: CashRulesService;
let customerId = '', riderUserId = '', riderId = '', vendorOwnerId = '', vendorId = '', itemId = '';
let gateLocal = 0;
const users: string[] = [];
const customerIds: string[] = [];
const claimIds: string[] = [];
const orderIds: string[] = [];
type Pair = { customerId: string; riderUserId: string; riderId: string };
let mkUser: (n: number, roles: string[], active: string, extra?: Record<string, unknown>) => Promise<{ id: string }>;
/** The fraud guardrails (pair, address, monthly count) are keyed on the mover and the customer:
 *  a test that needs a CLEAN claim gets its own pair at its own door. */
async function freshPair(n: number, door: { lat: number; lng: number }): Promise<Pair> {
  const c = await mkUser(n, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } }); users.push(c.id); customerIds.push(c.id);
  const r = await mkUser(n + 1, ['MOVER'], 'MOVER'); users.push(r.id);
  const rider = await system(() => app.prisma.rider.create({ data: { userId: r.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentLat: door.lat, currentLng: door.lng, lastLocationUpdate: new Date() } }));
  return { customerId: c.id, riderUserId: r.id, riderId: rider.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.ready();
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  notifications = new NotificationService(app.prisma, ioStub);
  cash = new CashRulesService(app.prisma, notifications, new OrderService(app.prisma, ioStub));
  const mk = (n: number, roles: string[], active: string, extra: Record<string, unknown> = {}) => runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+5926${NUM}${String(n).padStart(2, '0')}`, firstName: 'Loss', lastName: `Protect${n}`, roles: roles as never, activeRole: active as never, countryCode: COUNTRY, status: 'ACTIVE', isPhoneVerified: true, trustLevel: 'L2', ...extra,
  } as never }));
  mkUser = mk;
  const c = await mk(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } }); customerId = c.id; users.push(c.id); customerIds.push(c.id);
  const r = await mk(2, ['MOVER'], 'MOVER'); riderUserId = r.id; users.push(r.id);
  riderId = (await system(() => app.prisma.rider.create({ data: { userId: riderUserId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date() } }))).id;
  const v = await mk(3, ['VENDOR_OWNER'], 'VENDOR_OWNER'); vendorOwnerId = v.id; users.push(v.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: vendorOwnerId, vendors: { create: {
    name: `Loss Store ${RUN}`, slug: `loss-store-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59262${NUM}9`, addressLine1: '3 Test St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'ACTIVE',
  } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
  const category = await system(() => app.prisma.category.create({ data: { vendorId, name: `Menu ${RUN}`, sortOrder: 0 } }));
  itemId = (await system(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: `Plate ${RUN}`, basePrice: 1000 } as never }))).id;
  gateLocal = await cash['countryConfig'].getIdGateThresholdLocal(COUNTRY);
  expect(gateLocal).toBeGreaterThan(1000);
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.rlpReserveEntry.deleteMany({ where: { OR: [{ claimId: { in: claimIds } }, { countryCode: COUNTRY, note: { contains: RUN } }] } });
    await app.prisma.reimbursementClaim.deleteMany({ where: { OR: [{ id: { in: claimIds } }, { customerId: { in: customerIds } }] } });
    await app.prisma.strike.deleteMany({ where: { userId: { in: customerIds } } });
    await app.prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: customerIds } } });
    await app.prisma.item.deleteMany({ where: { id: itemId } });
    await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { data: { path: ['kind'], equals: 'rlp_sla_breached' } }, { data: { path: ['kind'], equals: 'rlp_reserve_low' } }, { data: { path: ['kind'], equals: 'rlp_reserve_provisioned' } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

/** A cash delivery order at the door, with the artefacts a real one carries: cart, pickup, arrival. */
async function atDoorOrder(opts: { food: number; fee?: number; arrived?: boolean; pickedUp?: boolean; cart?: boolean; status?: string; pair?: Pair; door?: { lat: number; lng: number } } ) {
  const fee = opts.fee ?? 500;
  const who = opts.pair ?? { customerId, riderUserId, riderId };
  const door = opts.door ?? DOOR;
  const order = await system(() => app.prisma.order.create({ data: {
    orderNumber: `RL${NUM}${nanoid(4).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase()}`, customerId: who.customerId, vendorId, riderId: who.riderId, status: (opts.status ?? 'ARRIVED') as never, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    paymentMethod: 'CASH', paymentStatus: 'PENDING', subtotalBase: opts.food, subtotalMarkup: 0, subtotalCustomer: opts.food, deliveryFee: fee, tipAmount: 0, totalAmount: opts.food + fee,
    deliveryAddress: '9 Cash Street', deliveryLat: door.lat, deliveryLng: door.lng, pickupLat: 6.8, pickupLng: -58.16, pickupAddress: 'Vendor corner',
    ...(opts.cart === false ? {} : { items: { create: { itemId, name: 'Plate', quantity: 1, basePrice: opts.food, markedUpPrice: opts.food, markupAmount: 0, totalBase: opts.food, totalMarkup: 0, totalCustomer: opts.food, selectedOptions: {} } } }),
  } as never }));
  orderIds.push(order.id);
  const t = Date.now();
  if (opts.pickedUp !== false) await system(() => app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'PICKED_UP', changedBy: who.riderId, note: 'fixture pickup', createdAt: new Date(t - 40 * 60_000) } }));
  if (opts.arrived !== false) await system(() => app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'ARRIVED', changedBy: who.riderId, note: 'fixture arrival', createdAt: new Date(t - 10 * 60_000) } }));
  return order;
}

/** A claim planted directly, the way older fixtures did — the invariant must hold for those too. */
async function plantClaim(orderId: string, amount: number, extra: Record<string, unknown> = {}) {
  const claim = await system(() => app.prisma.reimbursementClaim.create({ data: {
    orderId, riderId, customerId, amount, reason: 'no_show', gpsLat: DOOR.lat, gpsLng: DOOR.lng, status: 'AUTO_APPROVED', flags: [], ...extra,
  } as never }));
  claimIds.push(claim.id);
  return claim;
}

const fund = (amount: number) => system(() => app.prisma.rlpReserveEntry.create({ data: { countryCode: COUNTRY, kind: 'ADJUSTMENT', amount, note: `fixture ${RUN}` } }));
const balance = () => system(() => reserveBalance(app.prisma, COUNTRY));
const code = async (p: Promise<unknown>) => p.then(() => 'OK').catch((e: { code?: string }) => e.code ?? 'THREW');
const claimRow = (id: string) => system(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id } }));
const RULES = { maxHandoverDistanceKm: DEFAULT_CASH_RULES.maxHandoverDistanceKm };

describe('[DOC-1 P31-1] DOC-INV-47 — no loss-protection payout without a complete evidence bundle', () => {
  it('test_no_rlp_payout_without_evidence: a claim with no door photo is refused at payout, naming what is missing; the same claim pays once the bundle is complete', async () => {
    await fund(20_000);
    const order = await atDoorOrder({ food: 2000 });
    const claim = await plantClaim(order.id, 2000);
    const bundle = await system(() => assembleClaimEvidence(app.prisma, claim, RULES));
    expect(bundle.complete).toBe(false);
    expect(bundle.missing).toEqual(['door_photo']);
    const before = await balance();
    await expect(system(() => cash.markClaimPaid(claim.id, 'admin-pay', 'BANK-RLP-1', 2000))).rejects.toMatchObject({ code: 'RLP_EVIDENCE_INCOMPLETE' });
    expect((await claimRow(claim.id)).status).toBe('AUTO_APPROVED');
    expect(await balance()).toBe(before); // nothing was drawn for a refused payout
    await system(() => app.prisma.reimbursementClaim.update({ where: { id: claim.id }, data: { photoUrl: 'https://cdn.test/door.jpg' } }));
    const paid = await system(() => cash.markClaimPaid(claim.id, 'admin-pay', 'BANK-RLP-1', 2000));
    expect(paid.status).toBe('PAID');
    expect(await balance()).toBe(before - 2000);
    const draw = await system(() => app.prisma.rlpReserveEntry.findUnique({ where: { claimId: claim.id } }));
    expect(draw).toMatchObject({ kind: 'PAYOUT', countryCode: COUNTRY });
    expect(Number(draw!.amount)).toBe(-2000);
  });

  it('the bundle is assembled from artefacts, never typed: no arrival, no pickup, or an empty cart each leaves it incomplete; GPS far from the door fails the arrival item', async () => {
    const noArrival = await atDoorOrder({ food: 1500, arrived: false });
    const c1 = await plantClaim(noArrival.id, 1500, { photoUrl: 'https://cdn.test/1.jpg' });
    expect((await system(() => assembleClaimEvidence(app.prisma, c1, RULES))).missing).toEqual(['rider_at_door']);
    const noPickup = await atDoorOrder({ food: 1500, pickedUp: false });
    const c2 = await plantClaim(noPickup.id, 1500, { photoUrl: 'https://cdn.test/2.jpg' });
    expect((await system(() => assembleClaimEvidence(app.prisma, c2, RULES))).missing).toEqual(['pickup_proof']);
    const noCart = await atDoorOrder({ food: 1500, cart: false });
    const c3 = await plantClaim(noCart.id, 1500, { photoUrl: 'https://cdn.test/3.jpg' });
    expect((await system(() => assembleClaimEvidence(app.prisma, c3, RULES))).missing).toEqual(['cart_snapshot']);
    const farAway = await atDoorOrder({ food: 1500 });
    const c4 = await plantClaim(farAway.id, 1500, { photoUrl: 'https://cdn.test/4.jpg', gpsLat: DOOR.lat + 0.05, gpsLng: DOOR.lng });
    const far = await system(() => assembleClaimEvidence(app.prisma, c4, RULES));
    expect(far.missing).toEqual(['rider_at_door']);
    expect(far.items.find((i) => i.key === 'rider_at_door')?.detail?.['distanceM']).toBeGreaterThan(750);
    // Contact attempts are reported, never required, until a call artefact exists.
    expect(far.items.find((i) => i.key === 'customer_contacted')).toMatchObject({ required: false, present: false });
  });
});

describe('[DOC-1 P31-1] the policy: covered amount, caps, review threshold, suspension', () => {
  it('a real no-show at the door covers the FOOD COST the rider fronted, not the order total; the claim carries its bundle and is auto-approved when clean', async () => {
    const door = { lat: 6.8301, lng: -58.1702 };
    const pair = await freshPair(10, door);
    const order = await atDoorOrder({ food: 3000, fee: 800, pair, door });
    const result = await system(() => cash.handover(order.id, pair.riderUserId, { outcome: 'no_show', gps: door, photoUrl: 'https://cdn.test/door-real.jpg' }));
    const claim = result.claim!;
    claimIds.push(claim.id);
    expect(Number(claim.amount)).toBe(3000);
    expect(claim.evidenceComplete).toBe(true);
    expect(claim.status).toBe('AUTO_APPROVED');
    expect(claim.flags).toEqual([]);
    expect((claim.evidence as { rail: string }).rail).toBe('DELIVERY');
  });

  it('the cap per claim is the ID gate measured on the fronted cost: food just under the gate is covered even when the fee lifts the total over it', async () => {
    const food = Math.floor(gateLocal) - 100;
    const door = { lat: 6.8402, lng: -58.1803 };
    const pair = await freshPair(12, door);
    const order = await atDoorOrder({ food, fee: 2000, pair, door });
    const result = await system(() => cash.handover(order.id, pair.riderUserId, { outcome: 'no_show', gps: door, photoUrl: 'https://cdn.test/door-gate.jpg' }));
    expect(result.claim).not.toBeNull();
    claimIds.push(result.claim!.id);
    expect(Number(result.claim!.amount)).toBe(food);
    // Above the review threshold: a person decides, with the bundle.
    expect(result.claim!.flags).toContain(LOSS_PROTECTION_FLAGS.overReviewThreshold);
    expect(result.claim!.status).toBe('PENDING_REVIEW');
  });

  it('the rolling 30-day cap per rider: claims inside the window count, older ones do not', async () => {
    const cap = gateLocal * LOSS_PROTECTION_DEFAULTS.rlpMonthlyCapMultiple;
    const slice = Math.floor(cap / 3) + 1; // three of these breach the cap; two do not — and each is well below the gate
    expect(slice).toBeLessThan(gateLocal);
    const door = { lat: 6.8503, lng: -58.1904 };
    const pair = await freshPair(14, door);
    const plant = (orderId: string, extra: Record<string, unknown>) => plantClaim(orderId, slice, { riderId: pair.riderId, customerId: pair.customerId, gpsLat: door.lat, gpsLng: door.lng, ...extra });
    const old = await atDoorOrder({ food: slice, pair, door });
    await plant(old.id, { photoUrl: 'https://cdn.test/old.jpg', status: 'PAID', createdAt: new Date(Date.now() - 31 * 24 * HOUR) });
    const recent = await atDoorOrder({ food: slice, pair, door });
    await plant(recent.id, { photoUrl: 'https://cdn.test/recent.jpg', status: 'PAID', createdAt: new Date(Date.now() - 5 * 24 * HOUR) });
    const recent2 = await atDoorOrder({ food: slice, pair, door });
    await plant(recent2.id, { photoUrl: 'https://cdn.test/recent2.jpg', status: 'APPROVED', createdAt: new Date(Date.now() - 3 * 24 * HOUR) });
    const order = await atDoorOrder({ food: slice, pair, door });
    const result = await system(() => cash.handover(order.id, pair.riderUserId, { outcome: 'no_show', gps: door, photoUrl: 'https://cdn.test/door-cap.jpg' }));
    claimIds.push(result.claim!.id);
    expect(result.claim!.flags).toContain(LOSS_PROTECTION_FLAGS.overMonthlyCap); // recent + recent2 + this one > cap; the old one is outside the window
    expect(result.claim!.status).toBe('PENDING_REVIEW');
    // Move one recent claim out of the window: a further small claim now passes the cap.
    await system(() => app.prisma.reimbursementClaim.updateMany({ where: { orderId: { in: [recent.id, recent2.id] } }, data: { createdAt: new Date(Date.now() - 31 * 24 * HOUR) } }));
    const again = await atDoorOrder({ food: 1000, pair, door });
    const clean = await system(() => cash.handover(again.id, pair.riderUserId, { outcome: 'no_show', gps: door, photoUrl: 'https://cdn.test/door-cap2.jpg' }));
    claimIds.push(clean.claim!.id);
    expect(clean.claim!.flags).not.toContain(LOSS_PROTECTION_FLAGS.overMonthlyCap);
  });

  it('suspension is stated and told, never silent: the mover is notified, a new claim goes to review, an AUTO_APPROVED claim cannot be paid until a person approves it, and reinstatement is told too', async () => {
    await fund(10_000);
    const earlier = await atDoorOrder({ food: 1200 });
    const autoApproved = await plantClaim(earlier.id, 1200, { photoUrl: 'https://cdn.test/auto.jpg' });
    const facts: Record<string, unknown>[] = [];
    await system(() => cash.suspendLossProtection(riderUserId, 'confirmed collusion finding — case 42', async (_tx, f) => { facts.push(f); }));
    expect(facts[0]).toMatchObject({ reason: 'confirmed collusion finding — case 42' });
    const told = await system(() => app.prisma.notification.findFirst({ where: { userId: riderUserId, data: { path: ['kind'], equals: 'rlp_suspended' } } }));
    expect(told).not.toBeNull();
    const order = await atDoorOrder({ food: 1000 });
    const result = await system(() => cash.handover(order.id, riderUserId, { outcome: 'no_show', gps: DOOR, photoUrl: 'https://cdn.test/door-susp.jpg' }));
    claimIds.push(result.claim!.id);
    expect(result.claim!.flags).toContain(LOSS_PROTECTION_FLAGS.protectionSuspended);
    expect(result.claim!.status).toBe('PENDING_REVIEW');
    const notice = await system(() => app.prisma.notification.findFirst({ where: { userId: riderUserId, data: { path: ['claimId'], equals: result.claim!.id } }, select: { body: true } }));
    expect(notice?.body).toContain('suspended');
    expect(await code(system(() => cash.markClaimPaid(autoApproved.id, 'admin-pay', 'BANK-SUSP-1', 1200)))).toBe('RLP_PROTECTION_SUSPENDED');
    expect((await claimRow(autoApproved.id)).status).toBe('AUTO_APPROVED');
    // A person approves the reviewed claim — that is the human-review route — and the payout is allowed.
    await system(() => cash.approveClaim(result.claim!.id, 'admin-review', 'reviewed with the bundle'));
    const paid = await system(() => cash.markClaimPaid(result.claim!.id, 'admin-pay', 'BANK-SUSP-2', 1000));
    expect(paid.status).toBe('PAID');
    await system(() => cash.reinstateLossProtection(riderUserId, 'appeal upheld'));
    expect(await system(() => app.prisma.notification.count({ where: { userId: riderUserId, data: { path: ['kind'], equals: 'rlp_reinstated' } } }))).toBe(1);
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: riderUserId }, select: { lossProtectionSuspendedAt: true } }))).lossProtectionSuspendedAt).toBeNull();
    const now = await system(() => cash.markClaimPaid(autoApproved.id, 'admin-pay', 'BANK-SUSP-3', 1200));
    expect(now.status).toBe('PAID');
  });
});

describe('[DOC-1 P31-1] the reserve: a named, funded line — paid from it or not at all', () => {
  it('an empty or short reserve refuses the payout with the shortfall; the claim stays approved; funding it pays; the ledger entry names the claim', async () => {
    const drained = await balance();
    if (drained > 0) await fund(-drained);
    expect(await balance()).toBe(0);
    const order = await atDoorOrder({ food: 2500 });
    const claim = await plantClaim(order.id, 2500, { photoUrl: 'https://cdn.test/reserve.jpg' });
    await expect(system(() => cash.markClaimPaid(claim.id, 'admin-pay', 'BANK-RES-1', 2500))).rejects.toMatchObject({ code: 'RLP_RESERVE_UNFUNDED' });
    expect((await claimRow(claim.id)).status).toBe('AUTO_APPROVED');
    expect((await claimRow(claim.id)).paymentRef).toBeNull();
    await fund(2000); // still short by 500
    await expect(system(() => cash.markClaimPaid(claim.id, 'admin-pay', 'BANK-RES-1', 2500))).rejects.toMatchObject({ code: 'RLP_RESERVE_UNFUNDED' });
    await fund(500);
    const paid = await system(() => cash.markClaimPaid(claim.id, 'admin-pay', 'BANK-RES-1', 2500));
    expect(paid.status).toBe('PAID');
    expect(await balance()).toBe(0);
  });

  it('the database is the backstop: a raw entry that would take the line below zero is refused by the trigger, and the migration carries the trigger verbatim', async () => {
    const before = await balance();
    await expect(system(() => app.prisma.rlpReserveEntry.create({ data: { countryCode: COUNTRY, kind: 'PAYOUT', amount: -(before + 1), note: `fixture ${RUN} raw` } }))).rejects.toThrow(/RLP_RESERVE_UNFUNDED/);
    expect(await balance()).toBe(before);
    const migration = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '20260906130000_rlp_reserve', 'migration.sql'), 'utf8');
    expect(migration).toContain(rlpReserveDdl());
  });

  it('the manual entry is audited with the resulting balance and cannot overdraw either', async () => {
    const facts: Record<string, unknown>[] = [];
    const entry = await system(() => cash.adjustLossProtectionReserve(COUNTRY, 700, 'admin-fin', `fixture ${RUN} top-up`, async (_tx, f) => { facts.push(f); }));
    expect(facts[0]).toMatchObject({ countryCode: COUNTRY, amount: 700, reserveBalanceAfter: entry.balanceAfter });
    await expect(system(() => cash.adjustLossProtectionReserve(COUNTRY, -(entry.balanceAfter + 1), 'admin-fin', `fixture ${RUN} bad`))).rejects.toMatchObject({ code: 'RLP_RESERVE_UNFUNDED' });
    await expect(system(() => cash.adjustLossProtectionReserve(COUNTRY, 0, 'admin-fin', `fixture ${RUN} zero`))).rejects.toMatchObject({ code: 'RLP_AMOUNT_INVALID' });
    const statement = await system(() => cash.lossProtectionReserve(COUNTRY));
    expect(statement.balance).toBe(entry.balanceAfter);
    expect(statement.floor).toBe(gateLocal * LOSS_PROTECTION_DEFAULTS.rlpReserveFloorMultiple);
    expect(statement.entries[0]).toMatchObject({ kind: 'ADJUSTMENT', amount: '700' });
  });

  it('monthly provisioning: the previous month\'s PAID fee revenue times the rate, once per country per month — a replay adds nothing', async () => {
    const period = new Date(Date.UTC(2031, 3, 1)); // provisioning run on 2031-04-01 covers 2031-03
    const sub = await system(() => app.prisma.subscription.create({ data: { riderId, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 12000, currentPeriodStart: new Date(Date.UTC(2031, 2, 1)), currentPeriodEnd: new Date(Date.UTC(2031, 2, 8)), nextBillingDate: new Date(Date.UTC(2031, 2, 8)) } as never }));
    try {
      await system(() => app.prisma.subscriptionPayment.createMany({ data: [
        { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(2031, 2, 1)), periodEnd: new Date(Date.UTC(2031, 2, 8)), paidAt: new Date(Date.UTC(2031, 2, 3)) },
        { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(2031, 2, 8)), periodEnd: new Date(Date.UTC(2031, 2, 15)), paidAt: new Date(Date.UTC(2031, 2, 10)) },
        { subscriptionId: sub.id, amount: 12000, status: 'FAILED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(2031, 2, 15)), periodEnd: new Date(Date.UTC(2031, 2, 22)), paidAt: null },
        { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(2031, 3, 1)), periodEnd: new Date(Date.UTC(2031, 3, 8)), paidAt: new Date(Date.UTC(2031, 3, 2)) },
      ] as never }));
      const before = await balance();
      const rulesFor = async () => ({ ...LOSS_PROTECTION_DEFAULTS, rlpReserveRatePct: 2 });
      const first = await system(() => provisionReserveForPreviousMonth(app.prisma, { now: period, rulesFor, notifications }));
      const mine = first.find((r) => r.countryCode === COUNTRY);
      expect(mine).toMatchObject({ periodKey: '2031-03', created: true });
      expect(mine!.revenue).toBeGreaterThanOrEqual(24000); // the two PAID March payments; April and the failed one excluded
      expect(mine!.provisioned).toBe(Math.round(mine!.revenue * 2) / 100);
      expect(await balance()).toBe(before + mine!.provisioned);
      expect(await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_reserve_provisioned' } } }))).toBeGreaterThanOrEqual(1);
      const replay = await system(() => provisionReserveForPreviousMonth(app.prisma, { now: period, rulesFor }));
      expect(replay.find((r) => r.countryCode === COUNTRY)?.created).toBe(false);
      expect(await balance()).toBe(before + mine!.provisioned);
      await system(() => app.prisma.rlpReserveEntry.deleteMany({ where: { countryCode: COUNTRY, kind: 'PROVISION', periodKey: '2031-03' } }));
    } finally {
      await system(() => app.prisma.subscription.delete({ where: { id: sub.id } }));
    }
  });

  it('the daily sweep flags an approved claim unpaid past the SLA once, tells the admins once a day, and names a reserve below its floor', async () => {
    const stale = await atDoorOrder({ food: 900 });
    const claim = await plantClaim(stale.id, 900, { photoUrl: 'https://cdn.test/stale.jpg', createdAt: new Date(Date.now() - (LOSS_PROTECTION_DEFAULTS.rlpSlaHours + 2) * HOUR) });
    const fresh = await atDoorOrder({ food: 900 });
    const young = await plantClaim(fresh.id, 900, { photoUrl: 'https://cdn.test/fresh.jpg' });
    const rulesFor = async () => LOSS_PROTECTION_DEFAULTS;
    const gateFor = async () => gateLocal;
    const noticesBefore = await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_sla_breached' } } }));
    const run = await system(() => sweepLossProtection(app.prisma, { notifications, rulesFor, gateFor }));
    expect(run.breached.some((b) => b.claimId === claim.id)).toBe(true);
    expect(run.breached.some((b) => b.claimId === young.id)).toBe(false);
    expect((await claimRow(claim.id)).flags).toContain(LOSS_PROTECTION_FLAGS.slaBreached);
    expect((await claimRow(claim.id)).status).toBe('AUTO_APPROVED'); // the sweep pays nothing and moves nothing
    expect(run.lowReserve.find((l) => l.countryCode === COUNTRY)).toMatchObject({ floor: gateLocal * LOSS_PROTECTION_DEFAULTS.rlpReserveFloorMultiple });
    const noticesAfter = await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_sla_breached' } } }));
    expect(noticesAfter).toBeGreaterThanOrEqual(noticesBefore);
    const again = await system(() => sweepLossProtection(app.prisma, { notifications, rulesFor, gateFor }));
    expect(again.newlyFlagged).toBe(0);
    expect((await claimRow(claim.id)).flags.filter((f) => f === LOSS_PROTECTION_FLAGS.slaBreached)).toHaveLength(1);
    expect(await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_sla_breached' } } }))).toBe(noticesAfter);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'RLP_SWEEP', entityId: `daily:${new Date().toISOString().slice(0, 10)}` } }))).toBeGreaterThanOrEqual(2);
  });
});
