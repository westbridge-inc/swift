import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Phase-3 safety (pre-launch audit: no SOS was a rides-vertical blocker). A
// ride participant can raise an emergency; it alerts every admin and leaves an
// audit-log trace. A non-participant cannot touch someone else's ride SOS.
//
// [PRIV2-S1] The audit trail is the ops-only safety record, never the order
// timeline. The route used to write "SOS raised by <party>: <note> @lat,lng"
// into order_status_logs, which BOTH people on the ride read verbatim — so the
// person the SOS was about read the accusation and the live position on their
// next poll. These tests raise an SOS from each side and prove the other side's
// every surface is unchanged, while ops keep the note and the position.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_700_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Sos', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(), ...(roles.includes('CUSTOMER') && { customer: { create: {} } }) } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  // An ops session must carry OTP assurance to act (ADR-001), as in golden SAFE-01.
  const authMethod = roles.includes('ADMIN') ? 'OTP' : 'LEGACY';
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sos', deviceType: 'test', authMethod, expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

function inject(url: string, payload: unknown, token: string) {
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

function get(url: string, token?: string) {
  return app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

/** A taxi ride in progress, with the driver's app on it (the ride the driver's
 *  /rides/active poll returns). */
async function makeLiveRide() {
  const passenger = await makeUser(['CUSTOMER']);
  const driverUser = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({ data: { userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `SOS ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x' } });
  const ride = await app.prisma.order.create({
    data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, driverId: driver.id, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
  });
  await app.prisma.driver.update({ where: { id: driver.id }, data: { currentRideId: ride.id } });
  return { passenger, driverUser, ride };
}

type Broadcast = { event: string; rooms: string[] };

/** Every packet the socket server broadcasts while `fn` runs. io.to(room).emit,
 *  io.emit and a socket's broadcast all go through the namespace adapter's
 *  broadcast(), so this sees every one of them. */
async function socketBroadcastsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; broadcasts: Broadcast[] }> {
  const spy = vi.spyOn(app.io.sockets.adapter, 'broadcast');
  try {
    const result = await fn();
    const broadcasts = spy.mock.calls.map(([packet, opts]) => ({
      event: String((packet as { data?: unknown[] }).data?.[0]),
      rooms: [...((opts as { rooms?: Set<string> }).rooms ?? [])],
    }));
    return { result, broadcasts };
  } finally {
    spy.mockRestore();
  }
}

/** The broadcasts that could reach `userId` or anyone following the ride:
 *  their own rooms, the ride's room, any chat or session room, or everyone. */
function reachingParty(broadcasts: Broadcast[], userId: string, orderId: string) {
  return broadcasts.filter((b) => b.rooms.length === 0 || b.rooms.some((room) => room === `user:${userId}` || room === `order:${orderId}` || room.startsWith('chat:') || room.startsWith('session:')));
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  // order_status_logs are append-only (immutable audit); deleting the order
  // cascades them away, with the ride's trip-share tokens. SosAlert has no FK
  // to the order (orderId is a plain string), so it is deleted explicitly by
  // actor; its retrigger and escalation rows cascade. The evidence bundle and
  // the ops page name the alert by a plain id, so they go first, explicitly.
  const alertIds = (await app.prisma.sosAlert.findMany({ where: { actorUserId: { in: createdUserIds } }, select: { id: true } })).map((a) => a.id);
  await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } });
  await app.prisma.opsAlert.deleteMany({ where: { sosAlertId: { in: alertIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('ride SOS', () => {
  it('the passenger can raise it; it alerts admins and logs an audit trail', async () => {
    const admin = await makeUser(['ADMIN']);
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeUser(['MOVER']);
    const driver = await app.prisma.driver.create({ data: { userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `SOS ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x' } });
    const ride = await app.prisma.order.create({
      data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, driverId: driver.id, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
    });

    const res = await inject(`/api/v1/rides/${ride.id}/sos`, { lat: 6.81, lng: -58.14, note: 'being followed' }, passenger.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acknowledged).toBe(true);

    // Reconciled onto the ONE SOS engine (standing order #17): a ride panic is a
    // first-class SosAlert, ACTIVE at once (no grace — the button has no cancel
    // affordance), with the counterparty (the driver) captured for the war-room.
    const alertId = res.json().data.sosAlertId as string;
    expect(alertId).toBeTruthy();
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert.status).toBe('ACTIVE');
    expect(alert.graceEndsAt).toBeNull();
    expect(alert.orderId).toBe(ride.id);
    expect(alert.orderType).toBe('TAXI');
    expect(alert.actorUserId).toBe(passenger.userId);
    expect(alert.actorRole).toBe('CUSTOMER');
    expect(alert.counterpartyUserId).toBe(driverUser.userId);

    // Ops paged through the engine's fan-out (kind is the engine's 'sos_active').
    const adminNote = await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: { contains: 'SOS' } } });
    expect(adminNote).not.toBeNull();
    expect((adminNote!.data as { kind?: string })?.kind).toBe('sos_active');

    // [PRIV2-S1] The order's timeline, which the driver reads, gets nothing
    // at all; the free-text reason + coords are kept on the alert — the
    // ops-only record.
    expect.soft(await app.prisma.orderStatusLog.count({ where: { orderId: ride.id } }), 'order timeline rows').toBe(0);
    expect(alert.triggerNote).toBe('being followed');
    expect(alert.triggerLat).toBe(6.81);
    expect(alert.triggerLng).toBe(-58.14);
  });

  it('the driver can raise it too — actorRole MOVER, counterparty is the passenger', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeUser(['MOVER']);
    const driver = await app.prisma.driver.create({ data: { userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'Silver', licensePlate: `SOS ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x' } });
    const ride = await app.prisma.order.create({
      data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, driverId: driver.id, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
    });

    const res = await inject(`/api/v1/rides/${ride.id}/sos`, {}, driverUser.token);
    expect(res.statusCode).toBe(200);
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: res.json().data.sosAlertId } });
    expect(alert.status).toBe('ACTIVE');
    expect(alert.actorUserId).toBe(driverUser.userId);
    expect(alert.actorRole).toBe('MOVER');
    expect(alert.counterpartyUserId).toBe(passenger.userId);
  });

  it('a stranger cannot raise SOS on someone else’s ride', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const stranger = await makeUser(['CUSTOMER']);
    const ride = await app.prisma.order.create({
      data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
    });
    const res = await inject(`/api/v1/rides/${ride.id}/sos`, {}, stranger.token);
    expect(res.statusCode).toBe(404);
  });
});

describe('[PRIV2-S1] the other person on the ride never learns an SOS was raised', () => {
  it('passenger raises it: the driver sees no trace anywhere, and ops keep the note and the position', async () => {
    const { passenger, driverUser, ride } = await makeLiveRide();
    const admin = await makeUser(['ADMIN']);
    const note = 'PRIV2-A he is threatening me';
    const at = { lat: 6.80417, lng: -58.16329 };

    // Before anything happens: the driver's polled ride view, the timeline,
    // the driver's notifications, and the passenger's live trip-share page.
    const driverView = async () => {
      const r = await get('/api/v1/driver/rides/active', driverUser.token);
      expect(r.statusCode).toBe(200);
      return r;
    };
    const before = await driverView();
    expect(before.json().data.id).toBe(ride.id);
    const timelineBefore = await app.prisma.orderStatusLog.count({ where: { orderId: ride.id } });
    const driverNotificationsBefore = await app.prisma.notification.count({ where: { userId: driverUser.userId } });
    const share = await inject(`/api/v1/safety/trips/${ride.id}/share`, {}, passenger.token);
    expect(share.statusCode).toBe(200);
    const sharePage = `/api/v1/safety/public/trip/${share.json().data.token as string}`;
    const shareBefore = await get(sharePage);
    expect(shareBefore.statusCode).toBe(200);

    const { result: res, broadcasts } = await socketBroadcastsDuring(() => inject(`/api/v1/rides/${ride.id}/sos`, { ...at, note }, passenger.token));
    expect(res.statusCode).toBe(200);
    const alertId = res.json().data.sosAlertId as string;

    // THE DRIVER. Every surface they can read is checked and every leak is
    // reported (soft), not only the first. Their polled ride view is exactly
    // what it was — no note, no position, no marker, no alert id — and the
    // order timeline behind it gained no row.
    const after = await driverView();
    expect.soft(after.json(), 'the driver’s polled ride view').toEqual(before.json());
    for (const trace of [note, String(at.lat), String(at.lng), 'SOS raised', alertId]) expect.soft(after.payload, 'the driver’s polled ride view').not.toContain(trace);
    expect.soft(await app.prisma.orderStatusLog.count({ where: { orderId: ride.id } }), 'order timeline rows').toBe(timelineBefore);
    // No notification and no socket event reached them or the ride's room.
    // The positive control proves the spy saw the SOS fan-out, so the empty
    // list is a measurement, not a spy that saw nothing.
    expect.soft(await app.prisma.notification.count({ where: { userId: driverUser.userId } }), 'the driver’s notifications').toBe(driverNotificationsBefore);
    expect.soft(reachingParty(broadcasts, driverUser.userId, ride.id), 'socket broadcasts the driver could receive').toEqual([]);
    expect(broadcasts.some((b) => b.event === 'sos:active' && b.rooms.includes('ops:war-room'))).toBe(true);
    // No chat was opened or written, and the shared trip page is unchanged.
    expect.soft(await app.prisma.chatRoom.count({ where: { orderId: ride.id } }), 'chat rooms on the ride').toBe(0);
    const shareAfter = await get(sharePage);
    expect(shareAfter.statusCode).toBe(200);
    expect.soft(shareAfter.json(), 'the shared trip page').toEqual(shareBefore.json());
    // And the alert itself is not theirs to open or list.
    expect.soft((await get(`/api/v1/safety/sos/${alertId}`, driverUser.token)).statusCode, 'the driver opening the alert').toBe(403);
    expect.soft((await get('/api/v1/safety/sos', driverUser.token)).statusCode, 'the driver listing alerts').toBe(403);

    // OPS keep everything: the alert row, the ops API read, the evidence bundle.
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert).toMatchObject({ status: 'ACTIVE', actorUserId: passenger.userId, counterpartyUserId: driverUser.userId, triggerNote: note, triggerLat: at.lat, triggerLng: at.lng });
    const opsRead = await get(`/api/v1/safety/sos/${alertId}`, admin.token);
    expect(opsRead.statusCode).toBe(200);
    expect(opsRead.json().data).toMatchObject({ id: alertId, triggerNote: note, triggerLat: at.lat, triggerLng: at.lng });
    const bundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { sosAlertId: alertId }, include: { items: true } });
    expect(bundle.items.find((i) => i.kind === 'SOS_ALERT')?.content).toMatchObject({ id: alertId, triggerNote: note, triggerLat: at.lat, triggerLng: at.lng });
  });

  it('driver raises it: the passenger’s ride, order and live-ride reads show no trace, and ops keep everything', async () => {
    const { passenger, driverUser, ride } = await makeLiveRide();
    const admin = await makeUser(['ADMIN']);
    const note = 'PRIV2-B the passenger pulled a weapon';
    const at = { lat: 6.80583, lng: -58.15791 };

    const passengerViews = async () => {
      const views = {
        ride: await get(`/api/v1/rides/${ride.id}`, passenger.token),
        live: await get('/api/v1/rides/active', passenger.token),
        order: await get(`/api/v1/customer/orders/${ride.id}`, passenger.token),
      };
      for (const r of Object.values(views)) expect(r.statusCode).toBe(200);
      return views;
    };
    const before = await passengerViews();
    expect(before.live.json().data.id).toBe(ride.id);
    const timelineBefore = await app.prisma.orderStatusLog.count({ where: { orderId: ride.id } });
    const passengerNotificationsBefore = await app.prisma.notification.count({ where: { userId: passenger.userId } });

    const { result: res, broadcasts } = await socketBroadcastsDuring(() => inject(`/api/v1/rides/${ride.id}/sos`, { ...at, note }, driverUser.token));
    expect(res.statusCode).toBe(200);
    const alertId = res.json().data.sosAlertId as string;

    // THE PASSENGER. The ride detail and the live ride card are exactly what
    // they were; so is the order screen's timeline (the rest of that payload
    // carries clock-derived cancel previews); and no timeline row was added.
    const after = await passengerViews();
    expect.soft(after.ride.json(), 'the passenger’s ride detail').toEqual(before.ride.json());
    expect.soft(after.live.json(), 'the passenger’s live ride card').toEqual(before.live.json());
    expect.soft(after.order.json().data.timeline, 'the passenger’s order timeline').toEqual(before.order.json().data.timeline);
    for (const [surface, r] of Object.entries(after)) {
      for (const trace of [note, String(at.lat), String(at.lng), 'SOS raised', alertId]) expect.soft(r.payload, `the passenger’s ${surface} read`).not.toContain(trace);
    }
    expect.soft(await app.prisma.orderStatusLog.count({ where: { orderId: ride.id } }), 'order timeline rows').toBe(timelineBefore);
    expect.soft(await app.prisma.notification.count({ where: { userId: passenger.userId } }), 'the passenger’s notifications').toBe(passengerNotificationsBefore);
    expect.soft(reachingParty(broadcasts, passenger.userId, ride.id), 'socket broadcasts the passenger could receive').toEqual([]);
    expect(broadcasts.some((b) => b.event === 'sos:active' && b.rooms.includes('ops:war-room'))).toBe(true);
    expect.soft((await get(`/api/v1/safety/sos/${alertId}`, passenger.token)).statusCode, 'the passenger opening the alert').toBe(403);

    // OPS keep everything.
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert).toMatchObject({ status: 'ACTIVE', actorUserId: driverUser.userId, actorRole: 'MOVER', counterpartyUserId: passenger.userId, triggerNote: note, triggerLat: at.lat, triggerLng: at.lng });
    const opsRead = await get(`/api/v1/safety/sos/${alertId}`, admin.token);
    expect(opsRead.statusCode).toBe(200);
    expect(opsRead.json().data).toMatchObject({ id: alertId, triggerNote: note, triggerLat: at.lat, triggerLng: at.lng });
    const bundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { sosAlertId: alertId }, include: { items: true } });
    expect(bundle.items.find((i) => i.kind === 'SOS_ALERT')?.content).toMatchObject({ id: alertId, triggerNote: note, triggerLat: at.lat, triggerLng: at.lng });
  });

  it('the shipped app’s button (a position, no note) leaves no "SOS raised" marker for the driver either', async () => {
    const { passenger, driverUser, ride } = await makeLiveRide();
    const at = { lat: 6.80251, lng: -58.14872 };
    const before = await get('/api/v1/driver/rides/active', driverUser.token);
    expect(before.statusCode).toBe(200);

    // Exactly the body the mobile app's rideApi.sos sends.
    const res = await inject(`/api/v1/rides/${ride.id}/sos`, { lat: at.lat, lng: at.lng }, passenger.token);
    expect(res.statusCode).toBe(200);

    const after = await get('/api/v1/driver/rides/active', driverUser.token);
    expect.soft(after.json(), 'the driver’s polled ride view').toEqual(before.json());
    for (const trace of [String(at.lat), String(at.lng), 'SOS raised']) expect.soft(after.payload, 'the driver’s polled ride view').not.toContain(trace);
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: res.json().data.sosAlertId as string } });
    expect(alert).toMatchObject({ status: 'ACTIVE', triggerNote: null, triggerLat: at.lat, triggerLng: at.lng });
  });

  it('a repeat press keeps every note and position for ops, and still shows the driver nothing', async () => {
    const { passenger, driverUser, ride } = await makeLiveRide();
    const admin = await makeUser(['ADMIN']);
    const first = { lat: 6.80611, lng: -58.16042, note: 'PRIV2-D being followed' };
    const second = { lat: 6.80744, lng: -58.16188, note: 'PRIV2-D he has a knife now' };
    const before = await get('/api/v1/driver/rides/active', driverUser.token);
    expect(before.statusCode).toBe(200);

    const pressed = await inject(`/api/v1/rides/${ride.id}/sos`, first, passenger.token);
    const again = await inject(`/api/v1/rides/${ride.id}/sos`, second, passenger.token);
    expect(pressed.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    // One incident: the engine collapses a repeat press onto the live alert.
    const alertId = pressed.json().data.sosAlertId as string;
    expect(again.json().data.sosAlertId).toBe(alertId);

    // The driver: still nothing, after both presses.
    const after = await get('/api/v1/driver/rides/active', driverUser.token);
    expect.soft(after.json(), 'the driver’s polled ride view').toEqual(before.json());
    for (const trace of [first.note, second.note, String(first.lat), String(first.lng), String(second.lat), String(second.lng), 'SOS raised', alertId]) expect.soft(after.payload, 'the driver’s polled ride view').not.toContain(trace);
    expect.soft(await app.prisma.orderStatusLog.count({ where: { orderId: ride.id } }), 'order timeline rows').toBe(0);

    // Nothing overwritten, nothing dropped. The alert keeps the first note
    // (its position moves to the latest press, as the engine always has done);
    // the repeat's note and position are on its own immutable row and in the
    // summary the war room reads; the first position is in the evidence bundle.
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert).toMatchObject({ retriggerCount: 1, triggerNote: first.note, triggerLat: second.lat, triggerLng: second.lng });
    const repeats = await app.prisma.sosRetrigger.findMany({ where: { sosAlertId: alertId } });
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ seq: 1, note: second.note, lat: second.lat, lng: second.lng });
    const opsRead = await get(`/api/v1/safety/sos/${alertId}`, admin.token);
    expect(opsRead.statusCode).toBe(200);
    expect(opsRead.json().data).toMatchObject({ triggerNote: first.note, retriggers: [{ seq: 1, note: second.note, lat: second.lat, lng: second.lng }] });
    const bundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { sosAlertId: alertId }, include: { items: true } });
    expect(bundle.items.find((i) => i.kind === 'SOS_ALERT')?.content).toMatchObject({ triggerNote: first.note, triggerLat: first.lat, triggerLng: first.lng });
  });
});
