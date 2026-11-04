import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus } from '@prisma/client';
import { buildApp } from '../app';
import { AuthService } from '../modules/auth/auth.service';
import { DELIVERY_COMPLETED_LIFT, IncidentService } from '../modules/safety/incident.service';
import { DELIVERY_LIFT_KIND, DELIVERY_LIFT_WINDOW_MS, drainDeliveryLifts, persistDeliveryLift } from '../modules/safety/delivery-lift';
import { IN_PROCESS_OUTBOX_KINDS } from '../modules/order/checkout-outbox';
import { getTenantId } from '../plugins/tenant-context';
import { runWithoutTenant } from '../plugins/prisma';
import { fixtureTag, testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BUG-HUNT F18 · COORD 4 Nov 2026] A rider whose session ends with goods in the bag is suspended, and the rider can
// still finish the delivery. Finishing it used to leave them suspended until a person lifted it: an honest log-out to
// fix a glitch cost the working day. Goods only: the suspension lifts when THAT rider delivers THAT order. A person in
// the car, goods on the way back, a delivery someone else finished and a decision a person made all stay as they are.
// The case stays on the queue for ops either way. Synthetic data only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const GPS = { lat: 7.71, lng: -58.31 };
const DOOR = { lat: 7.7107, lng: -58.3107 };
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-logout-with-goods');

let app: FastifyInstance;
let incidents: IncidentService;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorId = '';

async function makeUser(roles: Array<'CUSTOMER' | 'RIDER' | 'DRIVER' | 'VENDOR_OWNER'>, activeRole: 'CUSTOMER' | 'RIDER' | 'DRIVER' | 'VENDOR_OWNER') {
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Goods', lastName: `Logout${fixtureTag(4)}`, roles, activeRole, status: 'ACTIVE',
      isPhoneVerified: true, selfieCapturedAt: new Date(), ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  });
  userIds.push(user.id);
  return user;
}

async function signIn(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId, token, refreshToken: nanoid(48), deviceId: `goods-${fixtureTag(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { token, sessionId: session.id };
}

async function makeRider() {
  const user = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const signedIn = await signIn(user.id, 'RIDER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true,
      locationSessionId: signedIn.sessionId, currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date(),
    },
  });
  return { userId: user.id, riderId: rider.id, ...signedIn };
}

async function makeOrder(riderId: string, status: OrderStatus, customerId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `GL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, riderId, status, fulfillment: 'DELIVERY',
      pickupAddress: 'Store corner', pickupLat: GPS.lat, pickupLng: GPS.lng, deliveryAddress: '9 Door Street', deliveryLat: DOOR.lat, deliveryLng: DOOR.lng,
      subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, totalAmount: 3500, paymentMethod: 'CASH', paymentStatus: 'PENDING',
      ridePin: '246810', acceptedAt: new Date(),
    },
  });
  orderIds.push(order.id);
  await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: order.id } });
  for (const [logged, ago] of [['PICKED_UP', 40], ['ARRIVED', 10]] as const) {
    await app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: logged, changedBy: riderId, note: 'fixture', createdAt: new Date(Date.now() - ago * 60_000) } });
  }
  return order;
}

/** The case and the stamp a session ending in custody leaves, through the real seam. */
async function logOutWithGoods(status: OrderStatus = 'ARRIVED') {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const rider = await makeRider();
  const order = await makeOrder(rider.riderId, status, customer.id);
  await new AuthService(app).logoutAll(rider.userId);
  const kase = await app.prisma.incidentCase.findFirstOrThrow({ where: { subjectUserId: rider.userId, orderId: order.id } });
  const back = await signIn(rider.userId, 'RIDER');
  return { customer, rider: { ...rider, ...back }, order, kase };
}

const stamp = async (riderId: string) => (await app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } })).safetySuspendedAt;
const liftRow = (orderId: string) => app.prisma.orderOutbox.findFirstOrThrow({ where: { orderId, kind: DELIVERY_LIFT_KIND } });
const liftRows = (orderId: string) => app.prisma.orderOutbox.count({ where: { orderId, kind: DELIVERY_LIFT_KIND } });
/** The row the delivery's transaction writes, without the real door's own post-commit drain. */
async function deliveredWithRow(orderId: string, riderUserId: string) {
  const order = await app.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
  await app.prisma.$transaction((tx) => persistDeliveryLift(tx, { ...order, rider: { userId: riderUserId } }));
}
const inject = (method: 'POST' | 'GET', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}),
});

beforeAll(async () => {
  vi.stubEnv('RUN_WORKERS', '0'); // requests only: the scheduler would leave recurring jobs on queues other suites read
  app = await buildApp();
  await app.ready();
  incidents = new IncidentService(app.prisma, app.io);
  await sys(async () => {
    const ownerUser = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: `Goods Kitchen ${wordFreeTag(6)}`, slug: `goods-kitchen-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
        addressLine1: '1 Store Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: GPS.lat, longitude: GPS.lng, status: 'ACTIVE',
      },
    });
    vendorId = vendor.id;
  });
}, 60_000);

afterAll(async () => {
  await sys(async () => {
    await app.prisma.rider.updateMany({ where: { userId: { in: userIds } }, data: { isOnline: false, isAvailable: false, currentOrderId: null } });
    await app.prisma.moverRevocationOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.custodyRecoveryCase.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
    await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
    await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => undefined);
  });
  await app?.close();
  vi.unstubAllEnvs();
});

describe('[F18] goods: the suspension lifts when the delivery completes', () => {
  it('rider logs out at the door, cannot go online, finishes the delivery through the real route, and is back', async () => {
    const { rider, order, kase, customer } = await logOutWithGoods();
    expect(await stamp(rider.riderId)).not.toBeNull();
    expect((await inject('POST', '/api/v1/rider/go-online', rider.token, GPS)).statusCode).toBe(423);

    const done = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, rider.token, { outcome: 'paid', gps: DOOR, ridePin: '246810' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.status).toBe('DELIVERED');

    expect(await stamp(rider.riderId)).toBeNull();
    // [BUG-HUNT F17] The real transition reads the store's type: a restaurant's customer still gets their line.
    const delivered = await app.prisma.notification.findFirstOrThrow({ where: { userId: customer.id, title: 'Delivered!' } });
    expect(delivered.body).toContain('Enjoy your meal!');
    const after = await app.prisma.incidentCase.findUniqueOrThrow({ where: { id: kase.id } });
    expect(after.interimAction).toBe('NONE');
    expect(after.status).toBe('OPEN'); // the case stays with ops
    expect((after.details as Record<string, unknown>)['interimLiftedBy']).toBe(DELIVERY_COMPLETED_LIFT);
    expect((await inject('POST', '/api/v1/rider/go-online', rider.token, GPS)).statusCode).not.toBe(423);
    const told = await app.prisma.notification.findMany({ where: { userId: rider.userId, title: 'Suspension lifted' } });
    expect(told).toHaveLength(1);
    expect((await liftRow(order.id)).processedAt).not.toBeNull();
  });

  it('what they were told at the time says so', async () => {
    const { rider } = await logOutWithGoods('PICKED_UP');
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: rider.userId, type: 'SAFETY' } });
    expect(notice.title).toBe('Account suspended until your delivery is finished');
    expect(notice.body).toContain('finish the delivery, and your account comes back by itself');
  });

  it('a second run changes nothing, and tells nobody twice', async () => {
    const { rider, order } = await logOutWithGoods();
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    expect(await incidents.liftAfterGoodsDelivered(order.id)).toBe(1);
    expect(await incidents.liftAfterGoodsDelivered(order.id)).toBe(0);
    expect(await app.prisma.notification.count({ where: { userId: rider.userId, title: 'Suspension lifted' } })).toBe(1);
  });

  it('a failed lift keeps its row owed, backed off, and the sweep finishes it', async () => {
    const { rider, order } = await logOutWithGoods();
    await deliveredWithRow(order.id, rider.userId);
    const failed = await drainDeliveryLifts({ prisma: app.prisma, lift: async () => { throw new Error('lift failed'); } }, { orderId: order.id });
    expect(failed).toMatchObject({ pending: 1, lifted: 0 });
    const owed = await liftRow(order.id);
    expect(owed.processedAt).toBeNull();
    expect(owed.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await stamp(rider.riderId)).not.toBeNull();
    await app.prisma.orderOutbox.updateMany({ where: { orderId: order.id }, data: { availableAt: new Date(0) } });
    const retried = await drainDeliveryLifts({ prisma: app.prisma, lift: (id) => incidents.liftAfterGoodsDelivered(id) }, { orderId: order.id });
    expect(retried).toMatchObject({ lifted: 1, pending: 0 });
    expect((await liftRow(order.id)).processedAt).not.toBeNull();
    expect(await stamp(rider.riderId)).toBeNull();
  });

  it('a lift that never lands closes after its window: the row ends, and the case is a person\'s', async () => {
    const { rider, order, kase } = await logOutWithGoods();
    await deliveredWithRow(order.id, rider.userId);
    const later = new Date(Date.now() + DELIVERY_LIFT_WINDOW_MS + 1000);
    const lift = vi.fn(async () => undefined);
    expect(await drainDeliveryLifts({ prisma: app.prisma, lift, now: () => later }, { orderId: order.id })).toMatchObject({ expired: 1, lifted: 0 });
    expect(lift).not.toHaveBeenCalled();
    expect((await liftRow(order.id)).processedAt).not.toBeNull();
    expect(await stamp(rider.riderId)).not.toBeNull();
    expect((await app.prisma.incidentCase.findUniqueOrThrow({ where: { id: kase.id } })).status).toBe('OPEN');
  });

  it('the lift runs bound to the order\'s tenant, in process, and the worker sweep carries it', async () => {
    const { rider, order } = await logOutWithGoods();
    await deliveredWithRow(order.id, rider.userId);
    let tenant: string | null = null;
    await drainDeliveryLifts({ prisma: app.prisma, lift: async () => { tenant = getTenantId(); } }, { orderId: order.id });
    expect(tenant).toBe(order.tenantId);
    // A published row closes when its queue accepts the job, which is not a lift.
    expect(IN_PROCESS_OUTBOX_KINDS).toContain(DELIVERY_LIFT_KIND);
    expect(readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8')).toMatch(/drainDeliveryLifts\(\{ prisma: ctx\.prisma, lift: liftAfterDelivery\(ctx\.prisma, ctx\.io\) \}\)/);
  });
});

describe('[F18] everything else stays with a person', () => {
  it('another open suspension keeps the account suspended', async () => {
    const { rider, order, customer } = await logOutWithGoods();
    await app.prisma.incidentCase.create({
      data: { caseNumber: `INC-GL-${nanoid(8)}`, status: 'OPEN', severity: 'S1', category: 'ASSAULT', intake: 'SYSTEM_AUTO', subjectUserId: rider.userId, summary: 'fixture', interimAction: 'SUSPENDED_PENDING_REVIEW', slaAckBy: new Date(Date.now() + DAY), slaDecideBy: new Date(Date.now() + DAY), tenantId: order.tenantId, reporterUserId: customer.id },
    });
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    await incidents.liftAfterGoodsDelivered(order.id);
    expect(await stamp(rider.riderId)).not.toBeNull();
  });

  it('a delivery another rider finished lifts nothing for the rider who left', async () => {
    const { rider, order } = await logOutWithGoods();
    const relay = await makeRider();
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED', riderId: relay.riderId } });
    expect(await incidents.liftAfterGoodsDelivered(order.id)).toBe(0);
    expect(await stamp(rider.riderId)).not.toBeNull();
    await app.prisma.$transaction((tx) => persistDeliveryLift(tx, { ...order, rider: { userId: relay.userId } }));
    expect(await liftRows(order.id)).toBe(0);
  });

  it('a decision a person made stands', async () => {
    const { rider, order, kase } = await logOutWithGoods();
    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { status: 'DECIDED', decisionCode: 'SUSPENSION_PERMANENT' } });
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    expect(await incidents.liftAfterGoodsDelivered(order.id)).toBe(0);
    expect(await stamp(rider.riderId)).not.toBeNull();
    await app.prisma.$transaction((tx) => persistDeliveryLift(tx, { ...order, rider: { userId: rider.userId } }));
    expect(await liftRows(order.id)).toBe(0);
  });

  it('goods on the way back: no lift, and the notice says a person reviews it', async () => {
    const { rider, order } = await logOutWithGoods('RETURNING');
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: rider.userId, type: 'SAFETY' } });
    expect(notice.title).toBe('Account suspended pending review');
    expect(notice.body).toContain('until a person at Swift has reviewed it');
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'RETURNED' } });
    expect(await incidents.liftAfterGoodsDelivered(order.id)).toBe(0);
    expect(await stamp(rider.riderId)).not.toBeNull();
  });

  it('a person in the car: a taxi never lifts here, whatever its status', async () => {
    const { rider, order } = await logOutWithGoods();
    await app.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED', orderType: 'TAXI', vendorId: null } });
    expect(await incidents.liftAfterGoodsDelivered(order.id)).toBe(0);
    expect(await stamp(rider.riderId)).not.toBeNull();
  });
});
