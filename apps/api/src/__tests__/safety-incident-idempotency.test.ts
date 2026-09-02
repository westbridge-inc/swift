import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { IncidentService, intakeFingerprint } from '../modules/safety/incident.service';
import { PrismaClient } from '@prisma/client';
import { resetDevChannelLog } from '../providers/notifications/channels';

// Trip Guardian M4c — the graduated check-in ladder (§5.3, self-test §14-E):
// L2 soft check-in → L3 hard check-in with a server deadline → L4 auto-SOS.
// The full climb is driven with scripted GPS through FRESH GuardianService
// instances per tick (worker-restart proof); responses go through the real
// authed routes. Scripted timestamps sit in the PAST so the ladder's deadline
// arithmetic works against real-clock responses.

let app: FastifyInstance;
const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }) } }),
} as unknown as Server;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_720_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Ladder',
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
      licensePlate: `LDR ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
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
      orderNumber: `LDR-${nanoid(8)}`,
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


const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

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

beforeEach(() => { resetDevChannelLog(); emits.length = 0; });

afterAll(async () => {
  await other.$disconnect().catch(() => {});
  await app.prisma.incidentCase.deleteMany({ where: { id: { in: caseIds } } }).catch(() => {});
  delete process.env['GUARDIAN_AUTONOTIFY_CONTACTS'];
  await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});


// ---------------------------------------------------------------------------
// [S-08] Incident intake has no source idempotency and retries fabricate severity.
//
// The register's red test: replay the same source key concurrently and
// sequentially — one case, one pattern contribution, one enforcement decision.
// Around it: the report route dedupes on the client's key and on reporter ×
// order × category; likely legacy duplicates are named by the scan and merged
// only by an explicit analyst action, which reverses enforcement the
// duplicate drove; the rollback intakes to the review queue.
// ---------------------------------------------------------------------------

const REPORT_URL = '/incidents';
const caseIds: string[] = [];
const svc = () => new IncidentService(app.prisma, io);
/** A second client with its own connection pool: the concurrent pair really races at the database. */
const other = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const svc2 = () => new IncidentService(other, io);
const track = <T extends { id: string }>(k: T) => { caseIds.push(k.id); return k; };
const casesFor = (fp: string) => app.prisma.incidentCase.count({ where: { sourceFingerprint: fp } });
const suspensionNotices = (userId: string) => app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'incident_interim_suspension' } } });
/** Ops are paged once per case: every admin holds exactly one page for it, however many admins there are. */
const pagesPerAdmin = async (caseId: string) => {
  const rows = await app.prisma.notification.findMany({ where: { data: { path: ['caseId'], equals: caseId }, title: { contains: 'Safety case' } }, select: { userId: true } });
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.userId, (per.get(r.userId) ?? 0) + 1);
  return { admins: per.size, max: Math.max(0, ...per.values()) };
};
const driverRow = (userId: string) => app.prisma.driver.findFirstOrThrow({ where: { userId } });

describe('[S-08] one source, one case', () => {
  it('the register’s red test: the same source replayed sequentially and concurrently is one case, paged once, with one enforcement decision', async () => {
    const subject = await makeDriver();
    const source = { type: 'TEST_REPORT', id: `src-${nanoid(8)}` };
    const first = track(await svc().intake({ category: 'SAFETY_THREAT', severity: 'S1', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'replay me', source }));
    expect(first.sourceFingerprint).toBe(intakeFingerprint(source));
    const again = await svc().intake({ category: 'SAFETY_THREAT', severity: 'S1', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'replay me', source });
    expect(again.id).toBe(first.id);
    const [a, b] = await Promise.all([
      svc().intake({ category: 'SAFETY_THREAT', severity: 'S1', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'replay me', source }),
      svc2().intake({ category: 'SAFETY_THREAT', severity: 'S1', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'replay me', source }),
    ]);
    expect(a.id).toBe(first.id); expect(b.id).toBe(first.id);
    expect(await casesFor(first.sourceFingerprint!)).toBe(1);
    expect((await app.prisma.incidentCase.findUniqueOrThrow({ where: { id: first.id } })).replayCount).toBe(3);
    // one enforcement decision: one interim suspension, one notice, one ops page
    expect((await driverRow(subject.userId)).safetySuspendedAt).not.toBeNull();
    expect(await suspensionNotices(subject.userId)).toBe(1);
    const pages = await pagesPerAdmin(first.id);
    expect(pages.admins).toBeGreaterThanOrEqual(1);
    expect(pages.max).toBe(1);
    expect(await app.prisma.incidentCase.count({ where: { subjectUserId: subject.userId } })).toBe(1);
    expect(first.patternFlaggedAt).toBeNull(); // a replay is no prior
    // a brand-new source raced by two clients at once: exactly one case
    const fresh = { type: 'TEST_REPORT', id: `race-${nanoid(8)}` };
    const [c, d] = await Promise.all([
      svc().intake({ category: 'SAFETY_THREAT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'race', source: fresh }),
      svc2().intake({ category: 'SAFETY_THREAT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'race', source: fresh }),
    ]);
    caseIds.push(c.id);
    expect(d.id).toBe(c.id);
    expect(await casesFor(intakeFingerprint(fresh))).toBe(1);
  });

  it('a genuinely different source is a second case — replays never counted toward the pattern, real reports do', async () => {
    const subject = await makeDriver();
    const one = track(await svc().intake({ category: 'SAFETY_THREAT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'one', source: { type: 'T', id: `a-${nanoid(6)}` } }));
    for (let i = 0; i < 3; i += 1) await svc().intake({ category: 'SAFETY_THREAT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'one', source: { type: 'T', id: one.sourceId! } });
    const two = track(await svc().intake({ category: 'SAFETY_THREAT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'two', source: { type: 'T', id: `b-${nanoid(6)}` } }));
    expect(two.id).not.toBe(one.id);
    expect(await app.prisma.incidentCase.count({ where: { subjectUserId: subject.userId } })).toBe(2);
  });

  it('the report route: the client’s key, else reporter × order × category, is one case across retries', async () => {
    const reporter = await makeUser(['CUSTOMER']);
    const driverUser = await makeDriver();
    const ride = await makeRide(driverUser.driver.id, reporter.userId, new Date());
    const key = `k-${nanoid(6)}`;
    const r1 = await post(`/api/v1/safety${REPORT_URL}`, { orderId: ride.id, category: 'CASH_DISPUTE', summary: 'the fare was wrong on this trip', idempotencyKey: key }, reporter.token);
    expect(r1.statusCode).toBe(200);
    const r2 = await post(`/api/v1/safety${REPORT_URL}`, { orderId: ride.id, category: 'CASH_DISPUTE', summary: 'the fare was wrong on this trip', idempotencyKey: key }, reporter.token);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.caseNumber).toBe(r1.json().data.caseNumber);
    const r3 = await post(`/api/v1/safety${REPORT_URL}`, { orderId: ride.id, category: 'CASH_DISPUTE', summary: 'the fare was wrong on this trip' }, reporter.token);
    const r4 = await post(`/api/v1/safety${REPORT_URL}`, { orderId: ride.id, category: 'CASH_DISPUTE', summary: 'the fare was wrong on this trip' }, reporter.token);
    expect(r4.json().data.caseNumber).toBe(r3.json().data.caseNumber);
    const cases = await app.prisma.incidentCase.findMany({ where: { reporterUserId: reporter.userId, orderId: ride.id } });
    caseIds.push(...cases.map((c) => c.id));
    expect(cases).toHaveLength(2); // the keyed report and the keyless one are two sources; each retried once
  });
});

describe('[S-08] operations: duplicates are named, merged only by a human, and the rollback', () => {
  it('the scan names a likely legacy duplicate that drove enforcement; the analyst merge closes it and reverses that enforcement', async () => {
    const subject = await makeDriver();
    const reporter = await makeUser(['CUSTOMER']);
    const now = Date.now();
    const mk = (offsetMs: number, interim: string) => app.prisma.incidentCase.create({ data: {
      caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S1', category: 'SAFETY_THREAT', intake: 'IN_TRIP_REPORT', subjectUserId: subject.userId, reporterUserId: reporter.userId, orderId: `ord-${subject.userId}`,
      summary: 'legacy report', slaAckBy: new Date(now + 3600_000), slaDecideBy: new Date(now + 86_400_000), interimAction: interim, createdAt: new Date(now + offsetMs),
    } });
    const survivor = track(await mk(0, 'NONE'));
    const dup = track(await mk(60_000, 'SUSPENDED_PENDING_REVIEW'));
    await app.prisma.driver.updateMany({ where: { userId: subject.userId }, data: { safetySuspendedAt: new Date(), isOnline: false, isAvailable: false } });
    const scan = await svc().scanDuplicateIntakes(new Date(now + 120_000));
    const cluster = scan.clusters.find((c) => c.survivorId === survivor.id);
    expect(cluster).toMatchObject({ duplicateIds: [dup.id], enforcementFromDuplicate: true });
    const ops = await makeUser(['ADMIN']);
    const merged = await svc().mergeDuplicate(dup.id, survivor.id, ops.userId);
    expect(merged.status).toBe('CLOSED');
    expect(merged.decisionNotes).toContain(survivor.caseNumber);
    expect((merged.details as { mergedInto: string }).mergedInto).toBe(survivor.id);
    expect((await driverRow(subject.userId)).safetySuspendedAt).toBeNull(); // reversed by the review
    expect((await svc().scanDuplicateIntakes(new Date(now + 120_000))).clusters.some((c) => c.survivorId === survivor.id)).toBe(false);
    await expect(svc().mergeDuplicate(survivor.id, survivor.id, ops.userId)).rejects.toThrow(/itself/);
  });

  it('the rollback: intake to the review queue creates the case and derives no enforcement', async () => {
    const subject = await makeDriver();
    process.env['INCIDENT_INTAKE_REVIEW_ONLY'] = '1';
    let kase;
    try {
      kase = track(await svc().intake({ category: 'SAFETY_THREAT', severity: 'S1', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'review me', source: { type: 'T', id: `r-${nanoid(6)}` } }));
    } finally {
      delete process.env['INCIDENT_INTAKE_REVIEW_ONLY'];
    }
    expect(kase.interimAction).toBe('NONE');
    expect((kase.details as { reviewQueue: boolean }).reviewQueue).toBe(true);
    expect((await driverRow(subject.userId)).safetySuspendedAt).toBeNull();
    expect(await suspensionNotices(subject.userId)).toBe(0);
  });
});
