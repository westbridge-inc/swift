import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { rateLimitOptions } from '../utils/rate-limit-options';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { GuardianService } from '../modules/safety/guardian.service';
import { NotificationService } from '../modules/notification/notification.service';
import { drainCheckinDeliveries } from '../modules/safety/guardian-delivery';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// [WEB-TAXI · owner 21 Oct 2026] Trip Guardian for a rider the push cannot
// reach — anyone who booked on the website (no app, no device), or a phone
// with push off. Before: the inbox row counted as "delivered", the hard
// deadline ran against a question nobody saw, and the ladder raised an
// automatic SOS about a rider who was never asked. Now the ask is texted to
// the rider's verified phone with a one-time answer link (no sign-in), the
// deadline runs from that text, and a rider reached by nothing fails the row
// fast so the explicit no-delivery policy runs on the phone's timetable.

let app: FastifyInstance;
const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }) } }),
} as unknown as Server;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'WebRider',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'grd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `WRD ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      totalRides: 500, createdAt: new Date(Date.now() - 90 * 86_400_000),
    },
  });
  return { ...u, driver };
}

const PICKUP = { lat: 6.8, lng: -58.15 };
const DEST = { lat: 6.82, lng: -58.13 };

async function makeRide(driverId: string, customerId: string, pickedUpAt: Date) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `WRD-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'RIDE_IN_PROGRESS',
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'B', deliveryLat: DEST.lat, deliveryLng: DEST.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      pickedUpAt, taxiDuration: 60,
    },
  });
  orderIds.push(order.id);
  return order;
}

const session = (orderId: string) => app.prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } });

/** Latch an anomaly directly (detector→flag chemistry is proven in the sweep
 *  suite; here the subject is the ladder that CONSUMES the latch). */
const latchFlag = (sessionId: string, kind: string, at: Date) =>
  app.prisma.tripSafetySession.update({
    where: { id: sessionId },
    data: { deviationState: { flags: { [kind]: at.toISOString() } } as never },
  });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // The server's own limiter, as app.ts registers it: the answer link must survive it.
  await app.register(rateLimit, rateLimitOptions({ verify: (token) => app.jwt.verify(token), max: 200 }));
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

beforeEach(() => { resetDevChannelLog(); emits.length = 0; });

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { data: { path: ['sessionId'], string_contains: '' }, title: { contains: 'not delivered' } } }).catch(() => {});
  delete process.env['GUARDIAN_AUTONOTIFY_CONTACTS'];
  await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});


const notifications = () => new NotificationService(app.prisma, io);
const rowsOf = (sessionId: string) => app.prisma.guardianCheckinDelivery.findMany({ where: { sessionId }, orderBy: [{ level: 'asc' }, { recipient: 'asc' }] });
const eventsOf = async (orderId: string) => (((await session(orderId)).deviationState as { events?: Array<{ kind: string }> }).events ?? []).map((e) => e.kind);
const undeliveredPages = (sessionId: string) => app.prisma.notification.count({ where: { data: { path: ['sessionId'], equals: sessionId }, title: { contains: 'not delivered' } } });
const sosCountFor = (sessionId: string) => app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian:${sessionId}` } });
const healthy = () => new GuardianService(app.prisma, io);
const textsTo = async (userId: string) => {
  const { phone } = await app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } });
  return devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);
};
/** The answer link a text carries: /safety-check#<session>.<secret>. */
const linkOf = (body: string) => {
  const m = /\/safety-check#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) /.exec(body);
  return m ? { ref: m[1]!, secret: m[2]! } : null;
};
const answer = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/safety/public/checkin', payload: body, remoteAddress: `10.77.${seq % 250}.${Math.floor(Math.random() * 250)}` });

/** A ride with a latched anomaly, swept once so its session exists. */
async function anomalousRide(t0: number, passengerExtra: Record<string, unknown> = {}) {
  const passenger = await makeUser(['CUSTOMER'], passengerExtra);
  const driverUser = await makeDriver();
  const ride = await makeRide(driverUser.driver.id, passenger.userId, new Date(t0));
  await healthy().sweep(new Date(t0));
  const s = await session(ride.id);
  await latchFlag(s.id, 'longStop', new Date(t0 + 60_000));
  return { passenger, driverUser, ride, sessionId: s.id, l2At: t0 + 120_000, l3At: t0 + 120_000 + 181_000 };
}

describe('[WEB-TAXI] a rider no push reaches is TEXTED the check-in, with a one-time answer link', () => {
  it('soft ask: one text to the verified phone; the row says it went by SMS; the secret is in the text only, then leaves the row', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, sessionId, l2At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    const texts = await textsTo(passenger.userId);
    expect(texts).toHaveLength(1);
    const link = linkOf(texts[0]!.body);
    expect(link?.ref).toBe(sessionId);
    expect(texts[0]!.body).toContain('Call 911');
    expect(texts[0]!.body).not.toMatch(/[—’]/); // GSM-7: one plain part
    const row = (await rowsOf(sessionId))[0]!;
    expect(row).toMatchObject({ level: 'SOFT', recipient: 'PASSENGER', status: 'SENT' });
    expect((row.receipt as { channel: string }).channel).toBe('sms');
    expect(JSON.stringify(row.payload)).not.toContain(link!.secret);
    // never in the inbox row, never on the socket
    const inbox = await app.prisma.notification.findMany({ where: { userId: passenger.userId, data: { path: ['kind'], equals: 'guardian_checkin' } } });
    expect(inbox).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain(link!.secret);
    expect(JSON.stringify(emits)).not.toContain(link!.secret);
    expect((await session(ride.id)).checkinRequestedAt).not.toBeNull();
  });

  it('hard ask: texted too; the link answers OK without signing in, once; a wrong or spent secret is the same 404', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, sessionId, l2At, l3At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    await healthy().sweep(new Date(l3At));
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    const texts = await textsTo(passenger.userId);
    expect(texts).toHaveLength(2);
    expect(texts[1]!.body).toContain('Please answer now');
    const hard = (await rowsOf(sessionId)).find((r) => r.level === 'HARD' && r.recipient === 'PASSENGER')!;
    expect(hard.status).toBe('SENT');
    expect((hard.receipt as { channel: string }).channel).toBe('sms');
    const link = linkOf(texts[1]!.body)!;
    const wrong = await answer({ ref: link.ref, secret: `${link.secret.slice(0, -2)}xx`, response: 'OK' });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().error.code).toBe('CHECKIN_NOT_AVAILABLE');
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    const ok = await answer({ ...link, response: 'OK' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ escalated: false, status: 'MONITORING' });
    const after = await session(ride.id);
    expect(after.status).toBe('MONITORING');
    expect(after.checkinRespondedAt).not.toBeNull();
    expect(await eventsOf(ride.id)).toContain('CHECKIN_OK');
    const again = await answer({ ...link, response: 'NEED_HELP' });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual(wrong.json());
    // the soft ask's link died with the cycle too
    expect((await answer({ ...linkOf(texts[0]!.body)!, response: 'OK' })).statusCode).toBe(404);
    expect(await sosCountFor(sessionId)).toBe(0);
  });

  it('the link answers NEED_HELP: an immediate SOS in the passenger’s name, exactly as their own tap', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, sessionId, l2At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    const link = linkOf((await textsTo(passenger.userId))[0]!.body)!;
    const res = await answer({ ...link, response: 'NEED_HELP' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.escalated).toBe(true);
    const alert = await app.prisma.sosAlert.findFirstOrThrow({ where: { clientIdempotencyKey: `guardian-help:${sessionId}` } });
    expect(alert).toMatchObject({ actorUserId: passenger.userId, triggerSource: 'GUARDIAN_ESCALATION', status: 'ACTIVE' });
    expect((await session(ride.id))).toMatchObject({ status: 'CLOSED', closeReason: 'ESCALATED', escalatedToSosId: alert.id });
  });

  it('the hard deadline runs from the TEXT, and with no answer the ladder escalates as for the phone', async () => {
    const t0 = Date.now() - 1_800_000;
    const { ride, sessionId, l2At, l3At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    await healthy().sweep(new Date(l3At));
    const s = await session(ride.id);
    // delivered by text at the tick's own clock: the full window from the text
    expect(s.checkinDeadlineAt!.getTime()).toBeGreaterThanOrEqual(l3At + 120_000);
    await healthy().sweep(new Date(l3At + 60_000));
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    await healthy().sweep(new Date(l3At + 121_000));
    expect((await session(ride.id)).status).toBe('CLOSED');
    expect(await sosCountFor(sessionId)).toBe(1);
  });

  it('a rider whose push WAS accepted is not texted: the push is the channel', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, sessionId, l2At } = await anomalousRide(t0);
    await app.prisma.deviceToken.create({ data: { userId: passenger.userId, token: `ExponentPushToken[wrd-${nanoid(10)}]`, platform: 'ios' } });
    await healthy().sweep(new Date(l2At));
    expect(await textsTo(passenger.userId)).toHaveLength(0);
    const row = (await rowsOf(sessionId))[0]!;
    expect(row.status).toBe('SENT');
    expect((row.receipt as { channel: string }).channel).toBe('push');
  });
});

describe('[WEB-TAXI] a rider reached by NOTHING: never a delivery, never an hour-long hold', () => {
  it('no push and no verified phone: the row is retried, FAILS within a few attempts, and the deadline escalates and says why', async () => {
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, sessionId, l2At, l3At } = await anomalousRide(t0, { isPhoneVerified: false });
    await healthy().sweep(new Date(l2At));
    await healthy().sweep(new Date(l3At));
    expect(await textsTo(passenger.userId)).toHaveLength(0);
    let hard = (await rowsOf(sessionId)).find((r) => r.level === 'HARD' && r.recipient === 'PASSENGER')!;
    expect(hard.status).toBe('PENDING'); // NOT a delivery: the inbox row alone asked nobody
    expect(hard.lastError).toContain('passenger not reached');
    // the deadline passes while it is still being retried: held, ops paged, no SOS yet
    await healthy().sweep(new Date(l3At + 121_000));
    expect((await session(ride.id)).status).toBe('CHECKIN_PENDING');
    expect(await eventsOf(ride.id)).toContain('DEADLINE_HELD_UNDELIVERED');
    expect(await undeliveredPages(sessionId)).toBeGreaterThanOrEqual(1);
    expect(await sosCountFor(sessionId)).toBe(0);
    // two more attempts (the worker's backoff, run now) and the row FAILS
    for (let i = 0; i < 2; i += 1) {
      await app.prisma.guardianCheckinDelivery.updateMany({ where: { sessionId, status: 'PENDING' }, data: { availableAt: new Date(Date.now() - 1000) } });
      await drainCheckinDeliveries(app.prisma, notifications(), { sessionIds: [sessionId] });
    }
    hard = (await rowsOf(sessionId)).find((r) => r.level === 'HARD' && r.recipient === 'PASSENGER')!;
    expect(hard.status).toBe('FAILED');
    expect(hard.attempts).toBe(3);
    expect(JSON.stringify(hard.payload)).not.toContain('answerToken');
    await healthy().sweep(new Date(l3At + 150_000));
    expect((await session(ride.id)).status).not.toBe('CHECKIN_PENDING');
    expect(await sosCountFor(sessionId)).toBe(1);
    expect(await eventsOf(ride.id)).toContain('DEADLINE_WITHOUT_DELIVERY');
  });
});

describe('[WEB-TAXI] the answer link refuses everything else alike', () => {
  it('a malformed body is a 400; an unknown session, a trip with nothing waiting or no secret is one 404', async () => {
    expect((await answer({ ref: 'x', response: 'OK' })).statusCode).toBe(400);
    const unknown = await answer({ ref: `c${nanoid(24)}`, secret: nanoid(22), response: 'OK' });
    expect(unknown.statusCode).toBe(404);
    const t0 = Date.now() - 1_800_000;
    const { sessionId } = await anomalousRide(t0); // no ask yet
    const idle = await answer({ ref: sessionId, secret: nanoid(22), response: 'NEED_HELP' });
    expect(idle.statusCode).toBe(404);
    expect(idle.json()).toEqual(unknown.json());
    expect(await app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian-help:${sessionId}` } })).toBe(0);
  });
});

// [REVIEW-F S3-1 · F-027-17] No rate limit stands between a person and HELP.
// Guyana's carriers put many riders behind one address (CGNAT): a valid
// answer from a busy address must land, every time.
describe('[WEB-TAXI] the answer link is never throttled for a valid answer', () => {
  const SHARED_IP = '10.99.0.1';
  const fromShared = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/safety/public/checkin', payload: body, remoteAddress: SHARED_IP });

  it('25 riders behind one address say "I need help" within a minute: every one lands and raises its SOS', async () => {
    await app.redis.del(`guardian-link-miss:${SHARED_IP}`);
    const t0 = Date.now() - 1_800_000;
    const asks: Array<{ ref: string; secret: string; sessionId: string }> = [];
    for (let i = 0; i < 25; i += 1) {
      const { passenger, sessionId, l2At } = await anomalousRide(t0);
      await healthy().sweep(new Date(l2At));
      asks.push({ ...linkOf((await textsTo(passenger.userId)).at(-1)!.body)!, sessionId });
    }
    for (const ask of asks) {
      const res = await fromShared({ ref: ask.ref, secret: ask.secret, response: 'NEED_HELP' });
      expect(res.statusCode, res.body).toBe(200);
    }
    for (const ask of asks) {
      expect(await app.prisma.sosAlert.count({ where: { clientIdempotencyKey: `guardian-help:${ask.sessionId}` } })).toBe(1);
    }
  }, 120_000);

  it('only misses are counted: past the miss limit an address gets 429 for misses, and a valid answer from it still lands', async () => {
    await app.redis.del(`guardian-link-miss:${SHARED_IP}`);
    const t0 = Date.now() - 1_800_000;
    const { passenger, ride, l2At } = await anomalousRide(t0);
    await healthy().sweep(new Date(l2At));
    const link = linkOf((await textsTo(passenger.userId))[0]!.body)!;
    const codes: number[] = [];
    for (let i = 0; i < 52; i += 1) codes.push((await fromShared({ ref: link.ref, secret: nanoid(22), response: 'OK' })).statusCode);
    expect(codes.slice(0, 50).every((c) => c === 404)).toBe(true);
    expect(codes.slice(50)).toEqual([429, 429]);
    const ok = await fromShared({ ...link, response: 'OK' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await session(ride.id)).status).toBe('MONITORING');
    await app.redis.del(`guardian-link-miss:${SHARED_IP}`);
  });
});
