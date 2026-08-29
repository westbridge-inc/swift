import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { IncidentService } from '../modules/safety/incident.service';
import { activateUserBlock, deactivateUserBlock } from '../modules/moderation/user-block.service';

// M6d — §8.5 retaliation guard + §8.3 SHADOW_RESTRICTED in dispatch.
// The guard lives INSIDE findCandidates, keyed on the booking user: a mover
// who shares an incident case with this customer (either direction) is never
// matched with them again, and a shadow-restricted mover is excluded from
// enhanced-monitoring passengers only. Availability probes (no booking user)
// pay nothing and see everything — proven here.

let app: FastifyInstance;
let dispatch: DispatchService;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_780_000_000 + Math.floor(Math.random() * 200_000_000);

// A remote corner of Guyana — ~170 km from every other suite's fixtures, so
// the geo query only ever sees THIS file's drivers.
const PICKUP = { lat: 7.51, lng: -59.51 };

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Excl', lastName: `U${seq}`,
      roles, activeRole: roles[0]!,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeDriverAt(offset: number, extra: Record<string, unknown> = {}) {
  const user = await makeUser(['MOVER']);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: `safety-dispatch-${seq}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  const driver = await app.prisma.driver.create({
    data: {
      userId: user.id,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `EXC ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isOnline: true, isAvailable: true,
      currentLat: PICKUP.lat + 0.001 * offset,
      currentLng: PICKUP.lng + 0.001 * offset,
      lastLocationUpdate: new Date(),
      locationSessionId: session.id,
      ...extra,
    },
  });
  return { userId: user.id, driver };
}

const find = (customerUserId: string | null) =>
  dispatch.findCandidates(`excl-${nanoid(6)}`, PICKUP, 5, 'DRIVER', 0, null, null, null, customerUserId);

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
  await app.ready();
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider());
});

afterAll(async () => {
  await app.prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }] } });
  await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§8.5 retaliation guard', () => {
  it('a reported driver is never dispatched to their reporter — either direction — while probes see everyone', async () => {
    const customer = await makeUser(['CUSTOMER']);
    const a = await makeDriverAt(1);
    const b = await makeDriverAt(2);

    // Baseline: both drivers in the pool for this customer.
    let ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).toContain(a.userId);
    expect(ids).toContain(b.userId);

    // Customer reported driver A (subject=A, reporter=customer).
    const inc = new IncidentService(app.prisma, app.io);
    await inc.intake({ category: 'SERVICE_QUALITY', intake: 'POST_TRIP_REPORT', subjectUserId: a.userId, reporterUserId: customer.id, summary: 'retaliation-guard fixture A' });
    ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).not.toContain(a.userId); // never matched again
    expect(ids).toContain(b.userId);

    // Reverse direction: driver B once reported THIS CUSTOMER (subject=customer).
    await inc.intake({ category: 'CASH_DISPUTE', intake: 'POST_TRIP_REPORT', subjectUserId: customer.id, reporterUserId: b.userId, summary: 'retaliation-guard fixture B' });
    ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).not.toContain(a.userId);
    expect(ids).not.toContain(b.userId); // retaliation risk has no direction

    // The availability probe has no booking user — it sees the whole pool
    // (and pays zero safety queries).
    const probe = (await find(null)).map((c) => c.userId);
    expect(probe).toContain(a.userId);
    expect(probe).toContain(b.userId);

    // A DIFFERENT customer with no history still gets both drivers.
    const other = await makeUser(['CUSTOMER']);
    const forOther = (await find(other.id)).map((c) => c.userId);
    expect(forOther).toContain(a.userId);
    expect(forOther).toContain(b.userId);
  });
});

describe('§8.3 SHADOW_RESTRICTED', () => {
  it('shields enhanced-monitoring passengers only; regular passengers and probes are unaffected', async () => {
    const ops = await makeUser(['ADMIN'], { admin: { create: { permissions: ['*'] } } });
    const enhanced = await makeUser(['CUSTOMER'], { enhancedSafetyMonitoring: true });
    const regular = await makeUser(['CUSTOMER']);
    const d = await makeDriverAt(3);

    const inc = new IncidentService(app.prisma, app.io);
    const kase = await inc.intake({ category: 'SAFETY_HARASSMENT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'S2 under review — shadow option' });
    await inc.shadowRestrict(kase.id, ops.id);

    const driverRow = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } });
    expect(driverRow.safetyShadowRestrictedAt).not.toBeNull();
    expect(driverRow.isOnline).toBe(true); // stays online — softer than suspension
    expect((await app.prisma.incidentCase.findUniqueOrThrow({ where: { id: kase.id } })).interimAction).toBe('SHADOW_RESTRICTED');
    expect(await app.prisma.notification.findFirst({ where: { userId: d.userId, title: 'Account under review' } })).not.toBeNull();

    expect((await find(enhanced.id)).map((c) => c.userId)).not.toContain(d.userId); // shielded cohort
    expect((await find(regular.id)).map((c) => c.userId)).toContain(d.userId); // general public unaffected
    expect((await find(null)).map((c) => c.userId)).toContain(d.userId); // probe unaffected

    // Lift clears every safety stamp at once — no stranded restrictions.
    await inc.liftInterim(kase.id, ops.id);
    const cleared = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } });
    expect(cleared.safetyShadowRestrictedAt).toBeNull();
    expect((await find(enhanced.id)).map((c) => c.userId)).toContain(d.userId);
  });
});

// [STORE-002] The customer's OWN block, in the same exclusion set as §8.5.
// A block is the retaliation guard stated by the person rather than by an
// incident case, so it belongs in the same place and behaves the same way:
// symmetric, liftable, and invisible to the availability probe.
describe('STORE-002 user blocks', () => {
  it('keeps blocked parties apart in BOTH directions, releases on unblock, and never touches probes or bystanders', async () => {
    const customer = await makeUser(['CUSTOMER']);
    const a = await makeDriverAt(4);
    const b = await makeDriverAt(5);

    // Baseline: both drivers reachable for this customer.
    let ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).toContain(a.userId);
    expect(ids).toContain(b.userId);

    // The customer blocks driver A.
    await activateUserBlock(app.prisma, {
      tenantId: 'swift-default', blockerId: customer.id, blockedId: a.userId, reason: 'block fixture A',
    });
    ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).not.toContain(a.userId);
    expect(ids).toContain(b.userId);

    // Reverse direction: driver B blocked the CUSTOMER. A mover's refusal is
    // as real as a customer's, so B leaves the pool too.
    await activateUserBlock(app.prisma, {
      tenantId: 'swift-default', blockerId: b.userId, blockedId: customer.id, reason: 'block fixture B',
    });
    ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).not.toContain(a.userId);
    expect(ids).not.toContain(b.userId);

    // The availability probe has no booking user: it still sees the whole
    // pool, so a block never makes the map read "no cars in your area".
    const probe = (await find(null)).map((c) => c.userId);
    expect(probe).toContain(a.userId);
    expect(probe).toContain(b.userId);

    // A bystander is unaffected — one person's block is not a moderation
    // decision anybody else inherits.
    const other = await makeUser(['CUSTOMER']);
    const forOther = (await find(other.id)).map((c) => c.userId);
    expect(forOther).toContain(a.userId);
    expect(forOther).toContain(b.userId);

    // Lifting it puts them back. A block that could not be undone would be a
    // trap for the person who placed it.
    await deactivateUserBlock(app.prisma, {
      tenantId: 'swift-default', blockerId: customer.id, blockedId: a.userId,
    });
    ids = (await find(customer.id)).map((c) => c.userId);
    expect(ids).toContain(a.userId);
    expect(ids).not.toContain(b.userId); // B's own block still stands
  });
});
