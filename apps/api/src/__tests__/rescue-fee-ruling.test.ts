/**
 * [F-07 · REPORT-070 · delegated ruling 2026-09-06] The rescue incentive is the fee.
 *
 * The food-age cutoff (45 min FOOD / 90 GROCERY) shipped live while the platform's
 * rescue incentive shipped at 0, and Codex asked which half should give. The ruling:
 * neither. The rescuer's incentive is the FULL delivery fee, forfeited by the rider who
 * handed the order back — a handback creates no earning, and the fee is earned once, at
 * DELIVERED, by whoever delivers. Every re-offer therefore already carries the whole fee;
 * Swift's own money (`rescue.incentiveGyd`) stays 0 unless the founder sets an amount.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import { FloatService } from '../modules/dispatch/float.service';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { rescueIncentiveGyd } from '../modules/dispatch/rescue';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { CashRulesService } from '../modules/cash/cash-rules.service';

const GEO = { lat: 6.8013, lng: -58.1553 };
const DOOR = { lat: GEO.lat + 0.004, lng: GEO.lng + 0.004 };
const NUM = String(Date.now()).slice(-4);
let app: FastifyInstance;
let cash: CashRulesService;
const createdUserIds: string[] = [];
const orderIds: string[] = [];
let vendorId: string;
let seq = 0;

async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+5920071${NUM}${seq}`, firstName: 'Resc', lastName: `Ue${seq}`, roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER' as UserRole,
    countryCode: 'GY', isPhoneVerified: true, status: 'ACTIVE',
  } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  const session = await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `rf-${NUM}-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3600_000) } });
  const rider = await app.prisma.rider.create({ data: {
    userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, isAvailable: true,
    locationSessionId: session.id, currentLat: GEO.lat, currentLng: GEO.lng, floatLimit: 40_000,
  } });
  return { user, rider, token };
}
async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+5920072${NUM}${seq}`, firstName: 'Cust', lastName: `Rf${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER' as UserRole, countryCode: 'GY', isPhoneVerified: true,
  } });
  createdUserIds.push(user.id);
  return user;
}
const handback = (orderId: string, token: string) => app.inject({ method: 'POST', url: `/api/v1/rider/orders/${orderId}/handback`, headers: { authorization: `Bearer ${token}` }, payload: { reason: 'vehicle broke down' } });
const earnings = (orderId: string) => app.prisma.earning.findMany({ where: { orderId }, select: { riderId: true, type: true, amount: true }, orderBy: { type: 'asc' } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  invalidateAlgoConfig();
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, ioStub), new OrderService(app.prisma, ioStub));
  const vendors = await app.prisma.vendor.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 1 });
  if (!vendors[0]) throw new Error('seeded ACTIVE vendor required');
  vendorId = vendors[0].id;
});
afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.reimbursementClaim.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { orderNumber: { startsWith: `RF${NUM}` } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[F-07 ruling] the rescue incentive is the fee', () => {
  it('a handback forfeits the fee: the abandoner earns nothing, the rescuer who delivers earns the FULL delivery fee', async () => {
    const abandoner = await makeRider();
    const rescuer = await makeRider();
    const customer = await makeCustomer();
    const order = await app.prisma.order.create({ data: {
      orderNumber: `RF${NUM}${nanoid(6)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: customer.id, vendorId,
      status: 'RIDER_ASSIGNED', paymentMethod: 'CASH', subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000,
      deliveryFee: 700, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, totalAmount: 3700,
      deliveryAddress: '1 Rescue St', deliveryLat: DOOR.lat, deliveryLng: DOOR.lng, pickupLat: GEO.lat, pickupLng: GEO.lng, pickupAddress: 'Vendor corner',
      riderId: abandoner.rider.id, acceptedAt: new Date(), readyAt: new Date(),
    } });
    orderIds.push(order.id);
    expect(await reserveRiderLeg(app.prisma, abandoner.rider.id, order.id, 2)).toBe(true);
    expect(await new FloatService(app.prisma).commit(app.prisma, abandoner.rider.id, 3000)).toBe(true);

    const res = await handback(order.id, abandoner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('READY_FOR_PICKUP');
    expect(await earnings(order.id)).toEqual([]); // the abandoner walked away from the fee

    // The rescuer takes the re-offered order, picks up, arrives, and collects at the door.
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: rescuer.rider.id, status: 'ARRIVED', pickedUpAt: new Date() } });
    await app.prisma.orderStatusLog.createMany({ data: [
      { orderId: order.id, status: 'PICKED_UP', changedBy: rescuer.rider.id, note: 'rescue pickup', createdAt: new Date(Date.now() - 20 * 60_000) },
      { orderId: order.id, status: 'ARRIVED', changedBy: rescuer.rider.id, note: 'rescue arrival', createdAt: new Date(Date.now() - 5 * 60_000) },
    ] });
    await app.prisma.rider.update({ where: { id: rescuer.rider.id }, data: { currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date() } });
    const delivered = await cash.handover(order.id, rescuer.user.id, { outcome: 'paid', gps: DOOR });
    expect(delivered.order.status).toBe('DELIVERED');

    const rows = await earnings(order.id);
    expect(rows).toEqual([{ riderId: rescuer.rider.id, type: 'DELIVERY_FEE', amount: expect.anything() }]);
    expect(Number(rows[0]!.amount)).toBe(700); // the whole fee, not a remaining-leg fraction
    expect(rows.some((r) => r.riderId === abandoner.rider.id)).toBe(false);
  });

  it("Swift's own rescue money stays 0 by decision at every cascade; the fee is the incentive", async () => {
    for (const cascade of [1, 2, 3, 6]) {
      expect(await rescueIncentiveGyd(app.prisma, cascade, 'swift-default')).toBe(0);
    }
  });
});
