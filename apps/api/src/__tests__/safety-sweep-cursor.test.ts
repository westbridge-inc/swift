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
import { GuardianService } from '../modules/safety/guardian.service';
import { EvidenceService } from '../modules/safety/evidence.service';
import { IncidentService } from '../modules/safety/incident.service';
import { SosService } from '../modules/safety/sos.service';
import { sweepPage, scanSweeps, POISON_PAGE_FAILURES } from '../lib/sweep-cursor';
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
const MIDWAY = { lat: 6.81, lng: -58.14 };

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

const putFix = (driverId: string, at: Date, pos: { lat: number; lng: number }) =>
  app.prisma.driver.update({ where: { id: driverId }, data: { currentLat: pos.lat, currentLng: pos.lng, lastLocationUpdate: at } });

const session = (orderId: string) => app.prisma.tripSafetySession.findUniqueOrThrow({ where: { orderId } });

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
  await app.prisma.sweepCursor.deleteMany({ where: { workType: { in: cursorKeys } } }).catch(() => {});
  await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } }).catch(() => {});
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
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
  await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {});
});


// ---------------------------------------------------------------------------
// [S-05] Fixed unpaginated safety sweeps can starve people forever.
//
// The register's red test: cap plus one rows, poison the earliest row,
// multiple tenants — every row progresses within bounded passes. Proven on
// the sweep primitive with a deterministic population, then on each real
// sweep: Guardian open and reconcile, the evidence live trail, the incident
// SLA watch (paged) and the cross-reporter scan (uncapped). Cursors are
// per-instance keys here so parallel suites cannot move them.
// ---------------------------------------------------------------------------

const cursorKeys: string[] = [];
const key = (w: string) => { const k = `${w}:t-${nanoid(6)}`; cursorKeys.push(k); return k; };
const cursorOf = (workType: string) => app.prisma.sweepCursor.findUniqueOrThrow({ where: { workType } });
const alertIds: string[] = [];
const tenantIds: string[] = [];

describe('[S-05] the sweep primitive: keyset pages, a persisted cursor, poison isolation', () => {
  it('cap plus one rows across two tenants with a poison first row: every other row is visited within ceil(n / page) ticks, the poison is recorded and skipped, the pass wraps', async () => {
    const workType = key('unit');
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r0${i + 1}`, tenant: i % 2 === 0 ? 'A' : 'B' }));
    const visits = new Map<string, number>();
    const tick = (now: Date) => sweepPage(app.prisma, workType, {
      pageSize: 3,
      now,
      fetch: async (afterId, limit) => rows.filter((r) => (afterId ? r.id > afterId : true)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit),
      handle: async (r) => { if (r.id === 'r01') throw new Error('poison row'); visits.set(r.id, (visits.get(r.id) ?? 0) + 1); },
      count: async (afterId) => rows.filter((r) => (afterId ? r.id > afterId : true)).length,
    });
    const t0 = new Date();
    const first = await tick(t0);
    expect(first).toMatchObject({ visited: 2, failed: 1, passCompleted: false, poisoned: ['r01'] });
    expect((await cursorOf(workType)).cursorId).toBe('r03');
    const second = await tick(new Date(t0.getTime() + 1000));
    expect(second).toMatchObject({ visited: 3, failed: 0, passCompleted: false });
    const third = await tick(new Date(t0.getTime() + 2000));
    expect(third).toMatchObject({ visited: 1, passCompleted: true }); // the short page ends the pass
    // bounded: every non-poison row visited exactly once within 3 ticks
    expect([...visits.keys()].sort()).toEqual(['r02', 'r03', 'r04', 'r05', 'r06', 'r07']);
    expect([...visits.values()].every((n) => n === 1)).toBe(true);
    const c = await cursorOf(workType);
    expect(c).toMatchObject({ cursorId: null, passesCompleted: 1, lastPassVisited: 6, lastPassFailed: 1 });
    expect((c.poison as Record<string, { failures: number; lastError: string }>)['r01']).toMatchObject({ failures: 1, lastError: 'poison row' });
    // a row that appears BEHIND the cursor is visited on the next pass; the poison keeps failing and never blocks
    rows.push({ id: 'r00', tenant: 'B' });
    await tick(new Date(t0.getTime() + 3000)); await tick(new Date(t0.getTime() + 4000)); await tick(new Date(t0.getTime() + 5000));
    expect(visits.get('r00')).toBe(1);
    expect((await cursorOf(workType)).passesCompleted).toBe(2);
    await tick(new Date(t0.getTime() + 6000));
    const scan = (await scanSweeps(app.prisma)).find((w) => w.workType === workType)!;
    expect(scan.poison.find((p) => p.id === 'r01')!.failures).toBe(3);
    expect(scan.repeatPoison.map((p) => p.id)).toContain('r01');
    expect(POISON_PAGE_FAILURES).toBe(3);
  });

  it('a page budget drains several persisted pages in one tick and stops at the pass end', async () => {
    const workType = key('budget');
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `b0${i + 1}` }));
    const seen: string[] = [];
    const fetch = async (afterId: string | null, limit: number) => rows.filter((r) => (afterId ? r.id > afterId : true)).slice(0, limit);
    const first = await sweepPage(app.prisma, workType, { pageSize: 3, maxPages: 2, fetch, handle: async (r) => { seen.push(r.id); } });
    expect(first).toMatchObject({ visited: 6, passCompleted: false });
    expect((await cursorOf(workType)).cursorId).toBe('b06');
    const second = await sweepPage(app.prisma, workType, { pageSize: 3, maxPages: 2, fetch, handle: async (r) => { seen.push(r.id); } });
    expect(second).toMatchObject({ visited: 1, passCompleted: true });
    expect(seen).toEqual(['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07']);
  });

  it('a pass that has run past the SLO is stalled — maximum due age, not processed counts', async () => {
    const workType = key('stall');
    const rows = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await sweepPage(app.prisma, workType, { pageSize: 2, now: twoHoursAgo, fetch: async (afterId, limit) => rows.filter((r) => (afterId ? r.id > afterId : true)).slice(0, limit), handle: async () => {} });
    const scan = (await scanSweeps(app.prisma, new Date())).find((w) => w.workType === workType)!;
    expect(scan.currentPassSeconds).toBeGreaterThan(7000);
    expect(scan.stalled).toBe(true);
    await sweepPage(app.prisma, workType, { pageSize: 2, fetch: async (afterId, limit) => rows.filter((r) => (afterId ? r.id > afterId : true)).slice(0, limit), handle: async () => {} });
    expect((await scanSweeps(app.prisma, new Date())).find((w) => w.workType === workType)!.stalled).toBe(false);
  });
});

describe('[S-05] the real sweeps walk their populations in pages', () => {
  it('Guardian open: three live rides in two tenants, page size two, the earliest poisoned — both others get sessions within two ticks and the pass completes', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const rides = [];
    for (let i = 0; i < 3; i += 1) { const { driver } = await makeDriver(); rides.push(await makeRide(driver.id, passenger.userId, new Date(Date.now() - 300_000))); }
    const other = await app.prisma.tenant.create({ data: { name: `Sweep Operator ${nanoid(4)}`, slug: `sweep-${nanoid(8).toLowerCase()}`, isActive: false } });
    tenantIds.push(other.id);
    await app.prisma.order.update({ where: { id: rides[1]!.id }, data: { tenantId: other.id } });
    const ids = rides.map((r) => r.id).sort();
    const cursorKey = `t-${nanoid(6)}`; cursorKeys.push(`guardian.open:${cursorKey}`, `guardian.reconcile:${cursorKey}`);
    const svc = new GuardianService(app.prisma, io, { openPageSize: 2, cursorKey, maxPages: 1 });
    svc.observer = { beforeOpen: async (orderId) => { if (orderId === ids[0]) throw new Error('cannot open'); } };
    await svc.sweep(new Date());
    expect(await cursorOf(`guardian.open:${cursorKey}`)).toMatchObject({ lastPageSize: 2, passesCompleted: 0 });
    // the shared population may hold other suites' rides: one full pass is ceil(n / 2) ticks, whatever n is
    const total = await app.prisma.order.count({ where: { orderType: 'TAXI', status: 'RIDE_IN_PROGRESS', driverId: { not: null } } });
    for (let i = 0; i < Math.ceil(total / 2) + 1; i += 1) await svc.sweep(new Date());
    const c = await cursorOf(`guardian.open:${cursorKey}`);
    expect(c.passesCompleted).toBeGreaterThanOrEqual(1);
    // every pass retries a poison row by design: at least one recorded failure, however many passes ran
    expect((c.poison as Record<string, { failures: number }>)[ids[0]!]!.failures).toBeGreaterThanOrEqual(1);
    for (const id of ids.slice(1)) expect(await app.prisma.tripSafetySession.findUnique({ where: { orderId: id } })).not.toBeNull();
    // the poison ride's own tenant and the other tenant were both walked: the pass covered the population
    expect(c.lastPassVisited + c.lastPassFailed).toBeGreaterThanOrEqual(3);
  });

  it('Guardian reconcile: page size two over three open sessions, one poisoned — the pass completes and names it', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const opener = new GuardianService(app.prisma, io, { cursorKey: `open-${nanoid(6)}` });
    cursorKeys.push(`guardian.open:${opener['sweepOpts'].cursorKey}`, `guardian.reconcile:${opener['sweepOpts'].cursorKey}`);
    const sessionIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { driver } = await makeDriver();
      const ride = await makeRide(driver.id, passenger.userId, new Date(Date.now() - 300_000));
      await opener.sweep(new Date());
      sessionIds.push((await session(ride.id)).id);
    }
    const mine = new Set(sessionIds); const poisonId = [...mine].sort()[0]!;
    const cursorKey = `t-${nanoid(6)}`; cursorKeys.push(`guardian.open:${cursorKey}`, `guardian.reconcile:${cursorKey}`);
    const svc = new GuardianService(app.prisma, io, { reconcilePageSize: 2, cursorKey, maxPages: 1 });
    svc.observer = { beforeReconcile: async (id) => { if (id === poisonId) throw new Error('cannot reconcile'); } };
    // enough ticks for one full pass whatever the shared population's size
    const total = await app.prisma.tripSafetySession.count({ where: { status: { in: ['MONITORING', 'CHECKIN_PENDING', 'ESCALATING'] } } });
    for (let i = 0; i < Math.ceil(total / 2) + 1; i += 1) await svc.sweep(new Date());
    const c = await cursorOf(`guardian.reconcile:${cursorKey}`);
    expect(c.passesCompleted).toBeGreaterThanOrEqual(1);
    expect((c.poison as Record<string, { failures: number; lastError: string }>)[poisonId]).toMatchObject({ lastError: 'cannot reconcile' });
  });

  it('evidence live trail: page size two over three open alerts, one poisoned — fixes land for the others and the pass completes', async () => {
    const sos = new SosService(app.prisma, io);
    const alerts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const passenger = await makeUser(['CUSTOMER']);
      const { driver } = await makeDriver();
      const ride = await makeRide(driver.id, passenger.userId, new Date(Date.now() - 300_000));
      await putFix(driver.id, new Date(), MIDWAY);
      const a = await sos.create({ actorUserId: passenger.userId, actorRole: 'CUSTOMER', orderId: ride.id, orderType: 'TAXI', immediate: true, lat: MIDWAY.lat, lng: MIDWAY.lng });
      alerts.push(a.id); alertIds.push(a.id);
      expect(await app.prisma.evidenceBundle.findUnique({ where: { sosAlertId: a.id } })).not.toBeNull();
    }
    const poisonId = [...alerts].sort()[0]!;
    const cursorKey = `t-${nanoid(6)}`; cursorKeys.push(`evidence.live-fixes:${cursorKey}`);
    const svc = new EvidenceService(app.prisma, io).withSweep({ pageSize: 2, cursorKey, maxPages: 1 });
    svc.observer = { beforeAppend: async (id) => { if (id === poisonId) throw new Error('cannot append'); } };
    const total = await app.prisma.sosAlert.count({ where: { status: { in: ['ACTIVE', 'ACKNOWLEDGED'] }, orderId: { not: null } } });
    for (let i = 0; i < Math.ceil(total / 2) + 1; i += 1) await svc.appendLiveFixes(new Date());
    const c = await cursorOf(`evidence.live-fixes:${cursorKey}`);
    expect(c.passesCompleted).toBeGreaterThanOrEqual(1);
    expect((c.poison as Record<string, { lastError: string }>)[poisonId]).toMatchObject({ lastError: 'cannot append' });
    for (const id of alerts.filter((a) => a !== poisonId)) {
      const bundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { sosAlertId: id } });
      expect(await app.prisma.evidenceItem.count({ where: { bundleId: bundle.id, kind: 'LOCATION_FIX' } })).toBeGreaterThanOrEqual(1);
    }
    const poisonBundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { sosAlertId: poisonId } });
    expect(await app.prisma.evidenceItem.count({ where: { bundleId: poisonBundle.id, kind: 'LOCATION_FIX' } })).toBe(0);
  });

  it('incident SLA watch: three breaching cases at page size two are all reported across one pass; the cross-reporter scan groups the whole year, not a capped page', async () => {
    const incidents = new IncidentService(app.prisma, io);
    const subject = await makeUser(['MOVER']);
    const caseIds: string[] = [];
    const reporters: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const reporter = await makeUser(['CUSTOMER']); reporters.push(reporter.userId);
      const k = await incidents.intake({ category: 'COMPLETION_ANOMALY', intake: 'POST_TRIP_REPORT', subjectUserId: subject.userId, reporterUserId: reporter.userId, summary: `sweep case ${i}` });
      caseIds.push(k.id);
    }
    await app.prisma.incidentCase.updateMany({ where: { id: { in: caseIds } }, data: { slaAckBy: new Date(Date.now() - 3600_000) } });
    const cursorKey = `t-${nanoid(6)}`; cursorKeys.push(`incident.sla:${cursorKey}`);
    const seen = new Set<string>();
    const total = await incidents.slaBreachCount(new Date());
    for (let i = 0; i < Math.ceil(total / 2) + 1; i += 1) for (const b of await incidents.slaWatch(new Date(), { pageSize: 2, cursorKey, maxPages: 1 })) seen.add(b.id);
    for (const id of caseIds) expect(seen.has(id)).toBe(true);
    expect((await cursorOf(`incident.sla:${cursorKey}`)).passesCompleted).toBeGreaterThanOrEqual(1);
    const flagged = await incidents.crossReporterScan(new Date());
    expect(flagged.find((f) => f.subjectUserId === subject.userId)).toMatchObject({ distinctReporters: 3 });
    const digest = await incidents.weeklyDigest(new Date());
    expect(digest.breaches).toBeGreaterThanOrEqual(3);
    await app.prisma.incidentCase.deleteMany({ where: { id: { in: caseIds } } });
  });
});
