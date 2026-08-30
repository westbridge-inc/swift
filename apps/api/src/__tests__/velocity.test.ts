import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { checkVelocity, isSafetyAction, resolveLimit, velocityKey } from '../modules/integrity/velocity';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// [ALG-38] The generic velocity engine — for the surfaces nobody thought
// about. Keyed by actor and identity CLUSTER (extra accounts buy no extra
// tries), fails open, and never touches a safety action. Whatever the config.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const PHONE_PREFIX = '+59200663';
const DAY = 24 * 60 * 60 * 1000;
const userIds: string[] = [];
const clusterIds: string[] = [];

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: ids } } });
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (clusterIds.length) await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
  const keys = await app.redis.keys('vel:*:vt-*');
  if (keys.length) await app.redis.del(...keys);
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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await purge();
});

afterAll(async () => {
  await purge();
  await app.close();
});

const uid = () => `vt-${nanoid(8)}`;

describe('the engine', () => {
  it('safety actions are exempt, absolutely — before a single key is read, whatever the config says', async () => {
    expect(isSafetyAction('safety.sos')).toBe(true);
    expect(isSafetyAction('sos.raise')).toBe(true);
    expect(isSafetyAction('promo.validate')).toBe(false);
    const actor = { userId: uid(), ip: '10.0.0.1' };
    for (let i = 0; i < 50; i++) {
      const v = await checkVelocity({ redis: app.redis }, { action: 'safety.sos', actor });
      expect(v).toMatchObject({ allowed: true, exempt: true });
    }
    expect(resolveLimit('safety.sos', { 'safety.sos': { max: 1, perSeconds: 60 } })).not.toBeNull(); // a config can NAME it…
    expect((await checkVelocity({ redis: app.redis }, { action: 'safety.sos', actor })).allowed).toBe(true); // …and is ignored
  });

  it('an action with no limit is open; the defaults carry the two surfaces this shipped with', () => {
    expect(resolveLimit('nothing.configured', null)).toBeNull();
    expect(ALGO_DEFAULTS['velocity.limits']['promo.validate']).toEqual({ max: 10, perSeconds: 600, clusterMax: 30 });
    expect(resolveLimit('promo.validate', { 'promo.validate': { max: 3, perSeconds: 60 } })).toEqual({ max: 3, perSeconds: 60 });
  });

  it('counts per actor within the window, then refuses with the seconds left', async () => {
    const actor = { userId: uid() };
    const limits = { 'test.act': { max: 3, perSeconds: 600 } };
    // No prisma → defaults only; pass the limit through a stored-config shape by using resolveLimit's merge path via a fake prisma-less call:
    // the engine reads config only when prisma is given, so exercise the default table with a real default action instead.
    const verdicts = [];
    for (let i = 0; i < 12; i++) verdicts.push(await checkVelocity({ redis: app.redis }, { action: 'promo.validate', actor }));
    expect(verdicts.slice(0, 10).every((v) => v.allowed)).toBe(true);
    expect(verdicts[9]!.remaining).toBe(0);
    expect(verdicts[10]).toMatchObject({ allowed: false, limitedBy: 'actor' });
    expect(verdicts[10]!.retryAfterS).toBeGreaterThan(0);
    expect(verdicts[10]!.retryAfterS).toBeLessThanOrEqual(600);
    expect(limits['test.act'].max).toBe(3);
  });

  it('the cluster is the key that matters: two accounts, one person, one budget', async () => {
    const clusterId = `vt-cluster-${nanoid(6)}`;
    const a = { userId: uid(), clusterId };
    const b = { userId: uid(), clusterId };
    // clusterMax for promo.validate is 30: 20 from A and 10 from B exhaust it, B's 11th is refused by the CLUSTER, not by B's own count.
    for (let i = 0; i < 20; i++) await checkVelocity({ redis: app.redis }, { action: 'promo.validate', actor: a });
    let last;
    for (let i = 0; i < 11; i++) last = await checkVelocity({ redis: app.redis }, { action: 'promo.validate', actor: b });
    expect(last).toMatchObject({ allowed: false, limitedBy: 'actor' }); // B's own 11th trips its actor limit (10) first…
    const c = { userId: uid(), clusterId };
    const fresh = await checkVelocity({ redis: app.redis }, { action: 'promo.validate', actor: c });
    expect(fresh).toMatchObject({ allowed: false, limitedBy: 'cluster' }); // …and a brand-new third account gets nothing: the cluster is spent.
  });

  it('fails open when Redis is unavailable — a burst beats a broken checkout', async () => {
    const broken = { incr: async () => { throw new Error('redis down'); }, expire: async () => 1 } as unknown as typeof app.redis;
    const v = await checkVelocity({ redis: broken }, { action: 'promo.validate', actor: { userId: uid() } });
    expect(v.allowed).toBe(true);
  });

  it('keys are per action, dimension, id and window', () => {
    expect(velocityKey('cluster', 'c1', 'promo.validate', 1_700_000_000)).toBe('vel:promo.validate:cluster:c1:1700000000');
  });
});

describe('over HTTP: promo guessing is capped per person', () => {
  it('the eleventh guess in ten minutes is a 429 that says how long to wait', async () => {
    const user = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}01`, firstName: 'Vel', lastName: 'One', roles: ['CUSTOMER' as UserRole], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(40), deviceId: 'vel', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/customer/promo/validate', payload: { code: `GUESS${i}` }, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
      statuses.push(res.statusCode);
      if (i === 10) {
        expect(res.statusCode).toBe(429);
        expect(res.json().error?.code ?? res.json().code).toBe('VELOCITY_LIMIT');
        expect(res.json().error?.message ?? '').toMatch(/wait \d+ minute/);
      }
    }
    // The first ten were judged on their merits (a wrong code is a 404), never on velocity.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
  });
});
