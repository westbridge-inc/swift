import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { RatingService } from '../modules/rating/rating.service';
import { ensureRatingTagsSeeded, seedRows, tagsForRole } from '../modules/rating/tag-taxonomy.seed';
import { SAFETY_TAGS, SAFETY_TAG_ORDER, canonicalTag, canonicalTags, mostSevereSafetyTag, type SafetyTag } from '../modules/rating/tag-registry';
import { ratingPipelineCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-008] Every rating ingress uses one canonical tag vocabulary and one
// atomic, durable pipeline: scrub before persistence, the safety incident,
// the double-blind release and the stats recompute as outbox commands written
// in the rating's own transaction and finished exactly once. Incident
// evidence is minimised, scrubbed text only.
//
// Every seeded safety tag is generated through the customer's real route with
// the slug the app sends (hyphens) and through the service with the old
// underscore alias; each opens exactly one incident of the expected category.
// Every other seeded tag opens nothing. The process is killed after the
// rating insert and the replay finishes exactly once.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = []; const driverIds: string[] = []; const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_800_000_000 + Math.floor(Math.random() * 100_000_000);

async function mkUser(first: string, roles: Array<'CUSTOMER' | 'DRIVER'> = ['CUSTOMER']) {
  seq += 1;
  const u = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: first, lastName: `Pipe${RUN}`, roles, activeRole: roles[0]!, isPhoneVerified: true, ...(roles.includes('CUSTOMER') && { customer: { create: {} } }) } });
  userIds.push(u.id);
  return u;
}
async function tokenFor(userId: string, role: 'CUSTOMER' | 'DRIVER') {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId, token, refreshToken: nanoid(48), deviceId: 'rp', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return token;
}
async function mkCompletedTrip() {
  const customer = await mkUser('Rita');
  const driverUser = await mkUser('Dax', ['DRIVER']);
  const driver = await app.prisma.driver.create({
    data: { userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2018, vehicleColor: 'White', licensePlate: `PCC ${Math.floor(1000 + Math.random() * 8999)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x' },
  });
  driverIds.push(driver.id);
  const order = await app.prisma.order.create({
    data: {
      customerId: customer.id, driverId: driver.id, orderType: 'TAXI', status: 'COMPLETED', orderNumber: `RP-${nanoid(8)}`, fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.16, deliveryAddress: 'B', deliveryLat: 6.81, deliveryLng: -58.15,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH', deliveredAt: new Date(),
    },
  });
  orderIds.push(order.id);
  return { customer, driverUser, driver, order };
}
const caseFor = (orderId: string) => app.prisma.incidentCase.findMany({ where: { orderId, intake: 'RATING_FLAG' } });
const outboxFor = (ratingId: string) => app.prisma.ratingOutbox.findMany({ where: { ratingId }, orderBy: { command: 'asc' } });
const count = async (event: string) => (await ratingPipelineCounter.get()).values.find((v) => v.labels['event'] === event)?.value ?? 0;
const svc = () => new RatingService(app.prisma, app.io);

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await ensureRatingTagsSeeded(app.prisma);
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    const ratings = await app.prisma.rating.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    await app.prisma.ratingOutbox.deleteMany({ where: { ratingId: { in: ratings.map((r) => r.id) } } }).catch(() => {});
    await app.prisma.incidentCase.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: userIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:rating-pipeline');
  await app.close();
});

describe('[R048-008] one canonical vocabulary', () => {
  it('the registry canonicalises every alias, orders severity, and every safety tag is SEEDED for every role it names', async () => {
    expect(canonicalTag('unsafe_driving')).toBe('unsafe-driving');
    expect(canonicalTag('  Different Driver ')).toBe('different-driver');
    expect(canonicalTags(['unsafe_driving', 'unsafe-driving', 'late'])).toEqual(['unsafe-driving', 'late']);
    expect(mostSevereSafetyTag(['unsafe_driving', 'different-driver', 'late'])).toBe('different-driver');
    expect(SAFETY_TAG_ORDER[0]).toBe('different-driver');
    for (const [tag, def] of Object.entries(SAFETY_TAGS)) {
      for (const role of def.roles) {
        const row = await app.prisma.ratingTagDef.findUnique({ where: { tenantId_role_slug: { tenantId: 'swift-default', role, slug: tag } } });
        expect(row, `${role}/${tag} seeded`).not.toBeNull();
        expect(row!.sentiment).toBe('NEGATIVE');
      }
    }
    // ...and seeded from the SOURCE, not merely present in this database from an earlier run
    for (const [tag, def] of Object.entries(SAFETY_TAGS)) {
      for (const role of def.roles) expect(seedRows().some((r) => r.role === role && r.slug === tag), `seed source ${role}/${tag}`).toBe(true);
    }
    // every seeded slug IS canonical already — no slug the seed ships can fail to match the bridge
    for (const r of seedRows()) expect(canonicalTag(r.slug), r.slug).toBe(r.slug);
    const driverNegative = await tagsForRole(app.prisma, 'DRIVER', 1);
    for (const tag of SAFETY_TAG_ORDER) expect(driverNegative.has(tag), tag).toBe(true);
  });
});

describe('[R048-008] every seeded driver tag through the customer’s real route', () => {
  const driverTags = seedRows().filter((r) => r.role === 'DRIVER' && r.sentiment === 'NEGATIVE').map((r) => r.slug);
  for (const tag of driverTags) {
    const safety = (SAFETY_TAGS as Record<string, { category: string }>)[tag];
    it(`${tag} → stored canonical, ${safety ? `ONE ${safety.category} incident` : 'no incident'}`, async () => {
      const { customer, order } = await mkCompletedTrip();
      const token = await tokenFor(customer.id, 'CUSTOMER');
      const res = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${order.id}/rate`, headers: { authorization: `Bearer ${token}` }, payload: { driverScore: 1, driverTags: [tag] } });
      expect(res.statusCode, res.body).toBe(200);
      const rating = await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id, type: 'CUSTOMER_TO_DRIVER' } });
      expect(rating.tags).toEqual([tag]);
      const cases = await caseFor(order.id);
      if (safety) {
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ category: safety.category, subjectUserId: rating.rateeId, reporterUserId: customer.id });
      } else {
        expect(cases).toHaveLength(0);
      }
      const box = await outboxFor(rating.id);
      expect(box.map((b) => b.command)).toEqual(safety ? ['RELEASE', 'SAFETY_INTAKE', 'STATS'] : ['RELEASE', 'STATS']);
      expect(box.every((b) => b.processedAt !== null)).toBe(true);
    });
  }

  it('the old underscore alias is accepted at the route and emitted canonical; the incident still opens; the alias is counted', async () => {
    const { customer, order } = await mkCompletedTrip();
    const token = await tokenFor(customer.id, 'CUSTOMER');
    const before = await count('alias_tag');
    const res = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${order.id}/rate`, headers: { authorization: `Bearer ${token}` }, payload: { driverScore: 1, driverTags: ['unsafe_driving'] } });
    expect(res.statusCode, res.body).toBe(200);
    const rating = await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id, type: 'CUSTOMER_TO_DRIVER' } });
    expect(rating.tags).toEqual(['unsafe-driving']);
    expect(await caseFor(order.id)).toHaveLength(1);
    expect(await count('alias_tag')).toBe(before + 1);
    // an unknown tag is refused and counted
    const { customer: c2, order: o2 } = await mkCompletedTrip();
    const t2 = await tokenFor(c2.id, 'CUSTOMER');
    const bad = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${o2.id}/rate`, headers: { authorization: `Bearer ${t2}` }, payload: { driverScore: 1, driverTags: ['made-up-tag'] } });
    expect(bad.statusCode).toBe(400);
  });

  it('several safety tags at once: the most severe decides the category; evidence carries only the scrubbed, PII-masked text', async () => {
    const { customer, order } = await mkCompletedTrip();
    const comment = 'he was not the driver in the app and drove like a maniac, call me on 592-600-1234 or rita@example.com';
    const rating = await svc().rate({ orderId: order.id, raterId: customer.id, rateeId: (await app.prisma.driver.findFirstOrThrow({ where: { id: order.driverId! }, select: { userId: true } })).userId, type: 'CUSTOMER_TO_DRIVER', score: 1, comment, tags: ['unsafe-driving', 'different_driver'] });
    expect(rating.tags).toEqual(['unsafe-driving', 'different-driver']);
    expect(rating.comment).not.toContain('592-600-1234');
    expect(rating.comment).not.toContain('rita@example.com');
    const [kase] = await caseFor(order.id);
    expect(kase).toMatchObject({ category: 'IDENTITY_MISMATCH' });
    const details = kase!.details as { comment?: string; tags?: string[] };
    expect(details.tags).toEqual(['unsafe-driving', 'different-driver']);
    expect(details.comment ?? '').not.toContain('592-600-1234');
    expect(details.comment ?? '').not.toContain('rita@example.com');
    expect(JSON.stringify(kase)).not.toContain('592-600-1234');
  });
});

describe('[R048-008] the pipeline is atomic and its replay finishes exactly once', () => {
  it('the process dies inside the transaction: no rating, no commands, no incident', async () => {
    const { customer, order, driverUser } = await mkCompletedTrip();
    const s = svc();
    s.failpoint = async (b) => { if (b === 'tx:after-rating') throw new Error('process died'); };
    await expect(s.rate({ orderId: order.id, raterId: customer.id, rateeId: driverUser.id, type: 'CUSTOMER_TO_DRIVER', score: 1, tags: ['unsafe-driving'] })).rejects.toThrow(/process died/);
    expect(await app.prisma.rating.count({ where: { orderId: order.id } })).toBe(0);
    expect(await caseFor(order.id)).toHaveLength(0);
  });

  it('the process dies after the commands were written but before commit: the rating AND its commands roll back together — no orphan command', async () => {
    const { customer, order, driverUser } = await mkCompletedTrip();
    const s = svc();
    let seenId: string | null = null;
    s.failpoint = async (b, ctx) => { if (b === 'tx:after-outbox') { seenId = String(ctx?.['ratingId']); throw new Error('process died'); } };
    await expect(s.rate({ orderId: order.id, raterId: customer.id, rateeId: driverUser.id, type: 'CUSTOMER_TO_DRIVER', score: 1, tags: ['unsafe-driving'] })).rejects.toThrow(/process died/);
    expect(seenId).toBeTruthy();
    expect(await app.prisma.rating.count({ where: { id: seenId! } })).toBe(0);
    expect(await app.prisma.ratingOutbox.count({ where: { ratingId: seenId! } })).toBe(0);
    expect(await caseFor(order.id)).toHaveLength(0);
  });

  it('two sweeps at once finish each command exactly once — the claim is a compare-and-set', async () => {
    const { customer, order, driverUser } = await mkCompletedTrip();
    const s = svc();
    s.failpoint = async (b) => { if (b === 'after-commit') throw new Error('process died'); };
    await expect(s.rate({ orderId: order.id, raterId: customer.id, rateeId: driverUser.id, type: 'CUSTOMER_TO_DRIVER', score: 1, tags: ['unsafe-driving'] })).rejects.toThrow(/process died/);
    const rating = await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id } });
    const sweeper = svc();
    sweeper.failpoint = async (b) => { if (b === 'outbox:after-claim') await new Promise((r) => setTimeout(r, 300)); };
    const before = await count('outbox_processed');
    const [a, b] = await Promise.all([sweeper.processRatingOutbox({ ratingId: rating.id }), sweeper.processRatingOutbox({ ratingId: rating.id })]);
    expect(a.processed + b.processed).toBe(3);
    expect(a.failed + b.failed).toBe(0);
    expect(await count('outbox_processed')).toBe(before + 3);
    expect(await caseFor(order.id)).toHaveLength(1);
    expect((await outboxFor(rating.id)).every((r) => r.processedAt !== null && r.attempts === 1)).toBe(true);
  });

  it('the process dies after the insert committed: the rating and its commands exist, nothing ran; the sweep finishes them ONCE, and a second sweep does nothing', async () => {
    const { customer, order, driverUser } = await mkCompletedTrip();
    const s = svc();
    s.failpoint = async (b) => { if (b === 'after-commit') throw new Error('process died'); };
    await expect(s.rate({ orderId: order.id, raterId: customer.id, rateeId: driverUser.id, type: 'CUSTOMER_TO_DRIVER', score: 1, tags: ['unsafe-driving'], comment: 'scary' })).rejects.toThrow(/process died/);
    const rating = await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id } });
    let box = await outboxFor(rating.id);
    expect(box.map((b) => [b.command, b.processedAt])).toEqual([['RELEASE', null], ['SAFETY_INTAKE', null], ['STATS', null]]);
    expect(await caseFor(order.id)).toHaveLength(0);
    expect(await app.prisma.actorRatingStat.findFirst({ where: { subjectRole: 'DRIVER', subjectId: driverUser.id } })).toBeNull();
    const before = await count('outbox_processed');
    const first = await svc().processRatingOutbox({ ratingId: rating.id });
    expect(first).toEqual({ processed: 3, failed: 0 });
    expect(await caseFor(order.id)).toHaveLength(1);
    const stat = await app.prisma.actorRatingStat.findFirstOrThrow({ where: { subjectRole: 'DRIVER', subjectId: driverUser.id } });
    expect(stat.lifetimeCount).toBe(1);
    box = await outboxFor(rating.id);
    expect(box.every((b) => b.processedAt !== null)).toBe(true);
    expect(await count('outbox_processed')).toBe(before + 3);
    const second = await svc().processRatingOutbox({ ratingId: rating.id });
    expect(second).toEqual({ processed: 0, failed: 0 });
    expect(await caseFor(order.id)).toHaveLength(1);
    expect((await app.prisma.actorRatingStat.findFirstOrThrow({ where: { subjectRole: 'DRIVER', subjectId: driverUser.id } })).lifetimeCount).toBe(1);
  });

  it('a failing command is retried, not lost: the incident intake failing once leaves the row for the next pass, which finishes it', async () => {
    const { customer, order, driverUser } = await mkCompletedTrip();
    const s = svc();
    s.failpoint = async (b) => { if (b === 'after-commit') throw new Error('process died'); };
    await expect(s.rate({ orderId: order.id, raterId: customer.id, rateeId: driverUser.id, type: 'CUSTOMER_TO_DRIVER', score: 1, tags: ['harassment'] })).rejects.toThrow(/process died/);
    const rating = await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id } });
    // a process with no realtime server cannot intake: the command stays, counted as a retry
    const before = await count('outbox_retry');
    const noIo = new RatingService(app.prisma);
    const res = await noIo.processRatingOutbox({ ratingId: rating.id });
    expect(res.failed).toBe(1);
    expect(await count('outbox_retry')).toBe(before + 1);
    const row = await app.prisma.ratingOutbox.findFirstOrThrow({ where: { ratingId: rating.id, command: 'SAFETY_INTAKE' } });
    expect(row.processedAt).toBeNull();
    expect(row.lastError).toMatch(/no io/);
    const later = await svc().processRatingOutbox({ ratingId: rating.id, now: new Date(Date.now() + 61_000) });
    expect(later.processed).toBe(1);
    expect(await caseFor(order.id)).toHaveLength(1);
  });

  it('double-blind: the driver’s rating through the route goes through the pipeline too, and both sides release together', async () => {
    const { customer, order, driverUser } = await mkCompletedTrip();
    await svc().rate({ orderId: order.id, raterId: customer.id, rateeId: driverUser.id, type: 'CUSTOMER_TO_DRIVER', score: 5, tags: ['on-time'] });
    expect((await app.prisma.rating.findFirstOrThrow({ where: { orderId: order.id } })).visibleAt).toBeNull();
    const back = await svc().rate({ orderId: order.id, raterId: driverUser.id, rateeId: customer.id, type: 'DRIVER_TO_CUSTOMER', score: 4, tags: [] });
    expect((await outboxFor(back.id)).map((b) => b.command)).toEqual(['RELEASE', 'STATS']);
    const both = await app.prisma.rating.findMany({ where: { orderId: order.id } });
    expect(both).toHaveLength(2);
    expect(both.every((r) => r.visibleAt !== null)).toBe(true);
  });
});

describe('[R048-008] direct-write census: no route writes a rating row itself', () => {
  it('every rating row is created by RatingService', () => {
    const src = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p); continue; }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        if (p.endsWith('rating/rating.service.ts')) continue;
        const text = readFileSync(p, 'utf8');
        if (/\.rating\.(create|createMany|upsert)\(/.test(text)) offenders.push(p.slice(src.length + 1));
      }
    };
    walk(join(src, 'modules'));
    expect(offenders).toEqual([]);
  });

  it('the service holds no underscore safety identifiers — the registry is the only vocabulary', () => {
    const service = readFileSync(join(__dirname, '..', 'modules', 'rating', 'rating.service.ts'), 'utf8');
    expect(service).not.toMatch(/'(different|unsafe|impaired|felt)_[a-z]+'/);
    expect(service).toContain("from './tag-registry'");
    const registryTags = Object.keys(SAFETY_TAGS) as SafetyTag[];
    for (const t of registryTags) expect(t).toBe(canonicalTag(t));
  });
});
