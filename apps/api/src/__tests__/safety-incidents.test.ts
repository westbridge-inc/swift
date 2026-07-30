import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { IncidentService, assertNotSafetySuspended } from '../modules/safety/incident.service';

// Incident Management M6a (safety spec §8) — the case machine. Severity is
// auto-suggested from category, SLA clocks stamp at intake, S0/S1 auto-apply
// the §8.3 interim suspension (due process: category only, never the
// reporter), the §8.4 on-intake pattern hook escalates repeat subjects, and
// the machine enforces OPEN→TRIAGED→INVESTIGATING→DECIDED→CLOSED with
// escalate-police as a parallel legalHold flag.

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const caseIds: string[] = [];
let seq = 0;
const phoneBase = 592_770_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Inc', lastName: `U${seq}`,
      roles, activeRole: roles[0]!,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'inc', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `INC ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isOnline: true, isAvailable: true,
    },
  });
  return { ...u, driver };
}

async function makeRide(driverId: string, customerId: string, status: string, createdAt?: Date) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `INC-${nanoid(8)}`,
      orderType: 'TAXI', customerId, driverId,
      status: status as never, fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      ...(createdAt ? { createdAt } : {}),
    },
  });
  orderIds.push(order.id);
  return order;
}

const svc = () => new IncidentService(app.prisma, app.io);
const track = <T extends { id: string }>(k: T): T => { caseIds.push(k.id); return k };

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
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.incidentCase.deleteMany({ where: { OR: [{ id: { in: caseIds } }, { subjectUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('intake — severity, SLA clocks, §8.3 interim suspension', () => {
  it('an S1 report auto-suspends the mover subject and tells them the CATEGORY, never the reporter', async () => {
    const admin = await makeUser(['ADMIN']);
    const reporter = await makeUser(['CUSTOMER']);
    const d = await makeDriver();

    const kase = track(await svc().intake({
      category: 'IDENTITY_MISMATCH', // → S1 by the table
      intake: 'IN_TRIP_REPORT',
      subjectUserId: d.userId,
      reporterUserId: reporter.userId,
      summary: 'Person driving does not match the profile photo',
    }));
    expect(kase.severity).toBe('S1');
    expect(kase.interimAction).toBe('SUSPENDED_PENDING_REVIEW');
    // SLA clocks: S1 = ack 1h / decide 48h from intake.
    expect(Math.round((kase.slaAckBy.getTime() - kase.createdAt.getTime()) / 60_000)).toBe(60);
    expect(Math.round((kase.slaDecideBy.getTime() - kase.createdAt.getTime()) / 3_600_000)).toBe(48);

    const driver = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } });
    expect(driver.safetySuspendedAt).not.toBeNull();
    expect(driver.isOnline).toBe(false); // invisible to dispatch instantly
    expect(() => assertNotSafetySuspended(driver)).toThrow(/contact support/i);

    // Due process without reporter leakage (§8.5).
    const subjectNote = await app.prisma.notification.findFirst({ where: { userId: d.userId, title: 'Account suspended pending review' } });
    expect(subjectNote).not.toBeNull();
    expect(subjectNote!.body).not.toContain(reporter.userId);
    expect(JSON.stringify(subjectNote!.data)).not.toContain(reporter.userId);
    expect(await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: { contains: kase.caseNumber } } })).not.toBeNull();
  });

  it('lower severities do not auto-suspend; S4 quality clocks are the slow lane', async () => {
    const d = await makeDriver();
    const kase = track(await svc().intake({
      category: 'SERVICE_QUALITY',
      intake: 'RATING_FLAG',
      subjectUserId: d.userId,
      summary: 'Car was untidy',
    }));
    expect(kase.severity).toBe('S4');
    expect(kase.interimAction).toBe('NONE');
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } })).safetySuspendedAt).toBeNull();
  });
});

describe('the case machine (§8.2)', () => {
  it('walks OPEN→TRIAGED→INVESTIGATING→DECIDED→CLOSED; a DISMISSED decision lifts the suspension', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({
      category: 'SAFETY_THREAT', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'Threatening message reported by phone',
    }));
    expect(kase.interimAction).toBe('SUSPENDED_PENDING_REVIEW');

    // Illegal move first: cannot close an un-decided case.
    await expect(svc().close(kase.id, ops.userId)).rejects.toThrow(/Cannot move/i);

    await svc().ack(kase.id, ops.userId);
    await svc().investigate(kase.id, ops.userId);
    const decided = await svc().decide(kase.id, ops.userId, 'DISMISSED', 'Misunderstanding — voice note was a joke between friends');
    expect(decided.interimAction).toBe('NONE'); // dismissed must not leave anyone suspended
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } })).safetySuspendedAt).toBeNull();
    expect(await app.prisma.notification.findFirst({ where: { userId: d.userId, title: 'Suspension lifted' } })).not.toBeNull();

    const closed = await svc().close(kase.id, ops.userId);
    expect(closed.status).toBe('CLOSED');
  });

  it('escalate-police is a parallel flag: any live status, sets legalHold, idempotent', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({
      category: 'SAFETY_ASSAULT', intake: 'SOS_RESOLUTION', subjectUserId: d.userId, summary: 'Assault reported at SOS resolution',
    }));
    const flagged = await svc().escalatePolice(kase.id, ops.userId);
    expect(flagged.legalHold).toBe(true);
    expect(flagged.escalatedPoliceAt).not.toBeNull();
    expect(flagged.status).toBe('OPEN'); // the machine keeps its own state
    const again = await svc().escalatePolice(kase.id, ops.userId);
    expect(again.escalatedPoliceAt?.getTime()).toBe(flagged.escalatedPoliceAt?.getTime());
  });
});

describe('§8.4 on-intake pattern hook', () => {
  it('a second S2+ case on the same subject inside 180 days escalates one band with a PATTERN stamp', async () => {
    const d = await makeDriver();
    track(await svc().intake({ category: 'SAFETY_HARASSMENT', intake: 'POST_TRIP_REPORT', subjectUserId: d.userId, summary: 'First report' }));
    const second = track(await svc().intake({ category: 'SAFETY_HARASSMENT', intake: 'POST_TRIP_REPORT', subjectUserId: d.userId, summary: 'Second report, different week' }));
    expect(second.severity).toBe('S1'); // S2 bumped one band
    expect(second.patternFlaggedAt).not.toBeNull();
    // The bump makes it S1 → interim applies via severity at intake time only
    // (the hook runs after) — the NEXT S2+ case on this subject starts S1.
  });
});

describe('report + ops routes', () => {
  it('a participant reports the other party; window enforced; ops queue sees it; strangers/non-ops do not', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const stranger = await makeUser(['CUSTOMER']);
    const admin = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const ride = await makeRide(d.driver.id, passenger.userId, 'COMPLETED');

    const res = await app.inject({
      method: 'POST', url: '/api/v1/safety/incidents',
      payload: { orderId: ride.id, category: 'DRIVING_DANGEROUS', summary: 'Ran two red lights on Vlissengen Road' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${passenger.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { caseNumber } = res.json().data;
    const kase = await app.prisma.incidentCase.findUniqueOrThrow({ where: { caseNumber } });
    caseIds.push(kase.id);
    expect(kase.subjectUserId).toBe(d.userId); // the OTHER party, inferred server-side
    expect(kase.reporterUserId).toBe(passenger.userId);
    expect(kase.intake).toBe('POST_TRIP_REPORT');

    // Window: a 31-day-old trip is closed for self-serve reports.
    const old = await makeRide(d.driver.id, passenger.userId, 'COMPLETED', new Date(Date.now() - 31 * 86_400_000));
    const late = await app.inject({
      method: 'POST', url: '/api/v1/safety/incidents',
      payload: { orderId: old.id, category: 'OTHER', summary: 'Very late report' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${passenger.token}` },
    });
    expect(late.statusCode).toBe(410);

    // A stranger is not a participant — the order does not exist for them.
    const nosy = await app.inject({
      method: 'POST', url: '/api/v1/safety/incidents',
      payload: { orderId: ride.id, category: 'OTHER', summary: 'I heard about this trip' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${stranger.token}` },
    });
    expect(nosy.statusCode).toBe(404);

    const queue = await app.inject({ method: 'GET', url: '/api/v1/safety/incidents?status=open', headers: { authorization: `Bearer ${admin.token}` } });
    expect(queue.statusCode).toBe(200);
    expect((queue.json().data as Array<{ caseNumber: string }>).find((c) => c.caseNumber === caseNumber)).toBeTruthy();
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/safety/incidents', headers: { authorization: `Bearer ${passenger.token}` } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('the breached queue reads blown SLA clocks', async () => {
    const admin = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({ category: 'CASH_DISPUTE', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'Fare dispute' }));
    let breached = await app.inject({ method: 'GET', url: '/api/v1/safety/incidents?status=breached', headers: { authorization: `Bearer ${admin.token}` } });
    expect((breached.json().data as Array<{ id: string }>).find((c) => c.id === kase.id)).toBeFalsy();

    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { slaAckBy: new Date(Date.now() - 60_000) } });
    breached = await app.inject({ method: 'GET', url: '/api/v1/safety/incidents?status=breached', headers: { authorization: `Bearer ${admin.token}` } });
    expect((breached.json().data as Array<{ id: string }>).find((c) => c.id === kase.id)).toBeTruthy();
  });
});
