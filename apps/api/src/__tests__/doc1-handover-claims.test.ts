/**
 * [DOC-1 §31.6 · DOC-INV-49 · P31-3] test_handover_claims_are_two_sided
 *
 * The delivery-fee handover is a two-sided claim row: the rider claims the fee was
 * received, the store claims it paid, each an audited assertion in the spec's words.
 * The nightly reconciliation walks every settlement older than the claim window and
 * reports the unmatched pairs — neither side, rider only, store only — as a
 * conversation: an audit row per run, one admin notice per day, nothing settled or
 * failed on anyone's behalf. Once both sides have confirmed, the pair is matched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { DeliveryCashSettlementService } from '../modules/cash/delivery-cash-settlement.service';
import { reconcileHandoverClaims } from '../modules/cash/handover-claims';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const HOUR = 3_600_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-handover-claims-test');

let app: FastifyInstance;
let notifications: NotificationService;
let settlements: DeliveryCashSettlementService;
let customerId = '', riderUserId = '', riderId = '', vendorOwnerId = '', vendorId = '';
const users: string[] = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  notifications = new NotificationService(app.prisma, app.io);
  settlements = new DeliveryCashSettlementService(app.prisma, notifications);
  const mk = (n: number, roles: string[], active: string, extra: Record<string, unknown> = {}) => runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59261${NUM}${n}`, firstName: 'Hand', lastName: `Over${n}`, roles: roles as never, activeRole: active as never, countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  const c = await mk(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } }); customerId = c.id; users.push(c.id);
  const r = await mk(2, ['MOVER'], 'MOVER'); riderUserId = r.id; users.push(r.id);
  riderId = (await system(() => app.prisma.rider.create({ data: { userId: riderUserId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  const v = await mk(3, ['VENDOR_OWNER'], 'VENDOR_OWNER'); vendorOwnerId = v.id; users.push(v.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: vendorOwnerId, vendors: { create: {
    name: `Handover Store ${RUN}`, slug: `handover-store-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59261${NUM}9`, addressLine1: '3 Test St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'ACTIVE', isVerified: true,
  } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.deliveryCashSettlement.deleteMany({ where: { vendorId } });
    await app.prisma.order.deleteMany({ where: { customerId } });
    await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { data: { path: ['kind'], equals: 'handover_claims_unmatched' } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

async function handover(ageHours: number, amount = 500) {
  const order = await system(() => app.prisma.order.create({ data: {
    orderNumber: `HC${NUM}${nanoid(4).toUpperCase()}`, customerId, vendorId, riderId, status: 'DELIVERED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: amount, tipAmount: 0, totalAmount: 2000 + amount,
    deliveryAddress: '1 Test St', deliveryLat: 6.8, deliveryLng: -58.16,
  } }));
  const s = await system(() => app.prisma.deliveryCashSettlement.create({ data: { orderId: order.id, riderId, vendorId, amount, status: 'OWED', createdAt: new Date(Date.now() - ageHours * HOUR) } }));
  return { order, settlement: s };
}
const audits = (action: string, entityId: string) => system(() => app.prisma.auditLog.count({ where: { action, entityId } }));
const notices = () => system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'handover_claims_unmatched' } } }));

describe('[DOC-1 P31-3] both sides of every handover, always', () => {
  it('a handover with neither, one, then both confirmations moves from unmatched to matched; each confirmation is an audited claim in the spec\'s words', async () => {
    const { settlement } = await handover(30);
    const fresh = await handover(1); // inside the window: not judged yet
    const first = await system(() => reconcileHandoverClaims(app.prisma, { windowHours: 24 }));
    const mine = first.unmatched.find((u) => u.settlementId === settlement.id);
    expect(mine).toMatchObject({ reason: 'NEITHER', orderId: settlement.orderId, amount: '500' });
    expect(first.unmatched.some((u) => u.settlementId === fresh.settlement.id)).toBe(false);
    expect(await audits('HANDOVER_CLAIMS_RECONCILED', `nightly:${new Date().toISOString().slice(0, 10)}`)).toBeGreaterThanOrEqual(1);

    await system(() => settlements.confirm(settlement.id, 'RIDER', { riderId }, { actorId: riderUserId, amount: 500 }));
    expect(await audits('RIDER_CLAIMED_FEE_RECEIVED', settlement.id)).toBe(1);
    const second = await system(() => reconcileHandoverClaims(app.prisma, { windowHours: 24 }));
    expect(second.unmatched.find((u) => u.settlementId === settlement.id)?.reason).toBe('RIDER_ONLY');

    await system(() => settlements.confirm(settlement.id, 'STORE', { vendorIds: [vendorId] }, { actorId: vendorOwnerId, amount: 500 }));
    expect(await audits('VENDOR_CLAIMED_RIDER_PAID_FEE', settlement.id)).toBe(1);
    expect((await system(() => app.prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id: settlement.id } }))).status).toBe('SETTLED');
    const third = await system(() => reconcileHandoverClaims(app.prisma, { windowHours: 24 }));
    expect(third.unmatched.some((u) => u.settlementId === settlement.id)).toBe(false);
  });

  it('the store-only case is named; the admins are told once a day, not once a run', async () => {
    const { settlement } = await handover(48);
    await system(() => settlements.confirm(settlement.id, 'STORE', { vendorIds: [vendorId] }, { actorId: vendorOwnerId, amount: 500 }));
    const before = await notices();
    const a = await system(() => reconcileHandoverClaims(app.prisma, { windowHours: 24, notifications }));
    expect(a.unmatched.find((u) => u.settlementId === settlement.id)?.reason).toBe('STORE_ONLY');
    const after = await notices();
    expect(after).toBeGreaterThanOrEqual(before);
    await system(() => reconcileHandoverClaims(app.prisma, { windowHours: 24, notifications }));
    expect(await notices()).toBe(after); // once a day
  });
});
