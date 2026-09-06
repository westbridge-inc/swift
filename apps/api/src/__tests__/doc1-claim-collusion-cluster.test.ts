/**
 * [DOC-1 §31.4 · P31-1 follow-up] "Repeat pairings → route to the identity graph."
 *
 * The single-account collusion checks miss the customer who is one person behind several
 * accounts. The identity graph already clusters those accounts (by its own signals — never
 * by claim behaviour); the guardrails now read the whole cluster: a claim against any account
 * in the cluster counts, and a mover who has claimed against the cluster before is a repeat
 * pairing. Flags only — a person decides; nothing is merged and nothing is refused.
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
import { CashRulesService } from '../modules/cash/cash-rules.service';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DOOR = { lat: 6.8611, lng: -58.1711 };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-claim-collusion-cluster-test');
let app: FastifyInstance;
let cash: CashRulesService;
let vendorId = '', itemId = '', clusterId = '';
const users: string[] = [];
const orderIds: string[] = [];
const claimIds: string[] = [];
type Cust = { id: string }; type Mover = { userId: string; riderId: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false }); registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.ready();
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, ioStub), new OrderService(app.prisma, ioStub));
  const o = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59274${NUM}0`, firstName: 'Cl', lastName: `Owner${RUN}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true } as never }));
  users.push(o.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: o.id, vendors: { create: { name: `Cluster Store ${RUN}`, slug: `cluster-store-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59274${NUM}9`, addressLine1: '1 Row', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'ACTIVE' } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
  const cat = await system(() => app.prisma.category.create({ data: { vendorId, name: `Menu ${RUN}`, sortOrder: 0 } }));
  itemId = (await system(() => app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Plate', basePrice: 1000 } as never }))).id;
});
afterAll(async () => {
  await system(async () => {
    await app.prisma.reimbursementClaim.deleteMany({ where: { id: { in: claimIds } } });
    await app.prisma.strike.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: users } } });
    if (clusterId) await app.prisma.identityCluster.deleteMany({ where: { id: clusterId } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.item.deleteMany({ where: { vendorId } }); await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } }); await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});
let seq = 0;
async function customer(): Promise<Cust> {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+5927${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Cl', lastName: `Cust${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, trustLevel: 'L2', customer: { create: {} } } as never }));
  users.push(u.id); return { id: u.id };
}
async function mover(): Promise<Mover> {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+5927${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Cl', lastName: `Mover${seq}`, roles: ['MOVER'], activeRole: 'MOVER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, trustLevel: 'L2' } as never }));
  users.push(u.id);
  const r = await system(() => app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date() } }));
  return { userId: u.id, riderId: r.id };
}
async function atDoor(c: Cust, m: Mover, door = DOOR) {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `CC${NUM}${nanoid(4).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase()}`, customerId: c.id, vendorId, riderId: m.riderId, status: 'ARRIVED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    paymentMethod: 'CASH', paymentStatus: 'PENDING', subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 500, tipAmount: 0, totalAmount: 2000,
    deliveryAddress: `${seq} Cluster St`, deliveryLat: door.lat, deliveryLng: door.lng, pickupLat: 6.8, pickupLng: -58.16, pickupAddress: 'Vendor corner',
    items: { create: { itemId, name: 'Plate', quantity: 1, basePrice: 1500, markedUpPrice: 1500, markupAmount: 0, totalBase: 1500, totalMarkup: 0, totalCustomer: 1500, selectedOptions: {} } },
  } as never }));
  orderIds.push(o.id);
  const t = Date.now();
  await system(() => app.prisma.orderStatusLog.createMany({ data: [
    { orderId: o.id, status: 'PICKED_UP', changedBy: m.riderId, note: 'fixture pickup', createdAt: new Date(t - 40 * 60_000) },
    { orderId: o.id, status: 'ARRIVED', changedBy: m.riderId, note: 'fixture arrival', createdAt: new Date(t - 10 * 60_000) },
  ] }));
  await system(() => app.prisma.rider.update({ where: { id: m.riderId }, data: { currentLat: door.lat, currentLng: door.lng, lastLocationUpdate: new Date() } }));
  return o;
}
async function plant(c: Cust, m: Mover, daysAgo: number) {
  const o = await atDoor(c, m);
  const cl = await system(() => app.prisma.reimbursementClaim.create({ data: { orderId: o.id, riderId: m.riderId, customerId: c.id, amount: 1500, reason: 'no_show', gpsLat: DOOR.lat, gpsLng: DOOR.lng, photoUrl: 'storage://t/d.jpg', status: 'PAID', flags: [], createdAt: new Date(Date.now() - daysAgo * 86_400_000) } as never }));
  claimIds.push(cl.id); return cl;
}

describe('[DOC-1 §31.4] repeat pairings are read through the identity graph', () => {
  it('a claim against another account in the customer\'s cluster flags the cluster; a mover who claimed against the cluster before is a repeat pairing; an unclustered customer is judged alone', async () => {
    const a = await customer(); const b = await customer(); const loner = await customer();
    clusterId = (await system(() => app.prisma.identityCluster.create({ data: {} }))).id;
    await system(() => app.prisma.identityClusterMember.createMany({ data: [
      { accountId: a.id, clusterId, linkedVia: [{ type: 'DEVICE', strength: 'HARD', matchedAccountId: b.id, at: new Date().toISOString() }] },
      { accountId: b.id, clusterId, linkedVia: [] },
    ] as never }));
    const m1 = await mover(); const m2 = await mover();
    await plant(a, m1, 20);           // m1 claimed against A
    await plant(a, m2, 15);           // m2 claimed against A too
    // m2 now claims against B — a different ACCOUNT, the same PERSON per the graph.
    const order = await atDoor(b, m2, { lat: DOOR.lat + 0.02, lng: DOOR.lng + 0.02 });
    const result = await system(() => cash.handover(order.id, m2.userId, { outcome: 'no_show', gps: { lat: DOOR.lat + 0.02, lng: DOOR.lng + 0.02 }, photoUrl: 'storage://t/b.jpg' }));
    claimIds.push(result.claim!.id);
    expect(result.claim!.flags).toContain('collusion_customer_cluster');
    expect(result.claim!.flags).toContain('collusion_pair_cluster');
    expect(result.claim!.flags).not.toContain('collusion_customer'); // B's own account had no prior claim
    expect(result.claim!.flags).not.toContain('collusion_pair');
    expect(result.claim!.status).toBe('PENDING_REVIEW'); // a person decides
    // The loner: no cluster, no cluster flags — the single-account checks stand alone.
    const m3 = await mover();
    const alone = await atDoor(loner, m3, { lat: DOOR.lat + 0.04, lng: DOOR.lng + 0.04 });
    const r2 = await system(() => cash.handover(alone.id, m3.userId, { outcome: 'no_show', gps: { lat: DOOR.lat + 0.04, lng: DOOR.lng + 0.04 }, photoUrl: 'storage://t/l.jpg' }));
    claimIds.push(r2.claim!.id);
    expect(r2.claim!.flags.filter((f) => f.startsWith('collusion'))).toEqual([]);
  });
});
