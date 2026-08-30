import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { floatAdvice } from '../modules/dispatch/float.service';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [ALG-26] The COD cash limit was built; the sentence was not. A rider whose
// float is spent stopped receiving cash offers and was told nothing. This is
// the nudge at the soft threshold and the explanation at the hard one —
// generated on the server, rendered as-is on the cockpit, never enforcement.
// ---------------------------------------------------------------------------

describe('floatAdvice — a level and one sentence from two numbers', () => {
  it('below the soft threshold there is nothing to say', () => {
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 6_900 })).toMatchObject({ level: 'ok', available: 3_100, sentence: null });
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 0 }).usedPct).toBe(0);
  });

  it('at the soft threshold: a nudge that names the numbers and what to do', () => {
    const a = floatAdvice({ floatLimit: 10_000, committedFloat: 7_000 });
    expect(a.level).toBe('soon');
    expect(a.sentence).toBe("You're fronting GY$7,000 of your GY$10,000 cash float — GY$3,000 left. Finish a delivery before taking more cash work, or the next cash offer will pass you by.");
  });

  it('at the hard threshold: the refusal explains itself, and says MMG work still comes', () => {
    const a = floatAdvice({ floatLimit: 10_000, committedFloat: 10_000 });
    expect(a.level).toBe('blocked');
    expect(a.available).toBe(0);
    expect(a.sentence).toMatch(/^Your cash float is fully in use — GY\$10,000 of GY\$10,000 is fronted to stores right now\./);
    expect(a.sentence).toMatch(/MMG-paid jobs still come through/);
  });

  it('the soft threshold is the config value, clamped, and the default is the seeded 70%', () => {
    expect(ALGO_DEFAULTS['float.softPct']).toBe(0.7);
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 5_000 }, 0.5).level).toBe('soon');
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 5_000 }, 0.7).level).toBe('ok');
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 9_999 }, 1.0).level).toBe('ok'); // 1.0 turns the nudge off; only the hard stop remains
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 2_000 }, 0.01).level).toBe('soon'); // clamped up to 10%
    expect(floatAdvice({ floatLimit: 10_000, committedFloat: 7_000 }, Number.NaN).level).toBe('soon');
  });

  it('a rider with no limit yet is simply ok — nothing to advise about', () => {
    expect(floatAdvice({ floatLimit: 0, committedFloat: 0 })).toMatchObject({ level: 'ok', usedPct: 0, sentence: null });
  });

  it('never the words of enforcement', () => {
    for (const committed of [7_000, 10_000]) {
      const s = floatAdvice({ floatLimit: 10_000, committedFloat: committed }).sentence ?? '';
      expect(s).not.toMatch(/deposit|confiscat|suspect|deduct|payout/i);
    }
  });
});

describe('the cockpit reads the sentence from the profile, and renders it as-is', () => {
  const PHONE_PREFIX = '+59200659';
  const DAY = 24 * 60 * 60 * 1000;
  let app: FastifyInstance;
  const userIds: string[] = [];

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
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
    await app.register(riderRoutes, { prefix: '/api/v1/rider' });
    await app.ready();
    await purge();
  });

  afterAll(async () => {
    await purge();
    await app.close();
  });

  it('GET /rider/profile carries float.advice with the level and the sentence', async () => {
    const user = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}01`, firstName: 'Float', lastName: 'Rider', roles: ['RIDER'], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(user.id);
    await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', floatLimit: 10_000, committedFloat: 8_000, locationSessionId: syntheticLocationOwner('float-advice') } });
    const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(40), deviceId: 'fa', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/rider/profile', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const f = res.json().data.float;
    expect(f).toMatchObject({ limit: 10_000, committed: 8_000, available: 2_000 });
    expect(f.advice.level).toBe('soon');
    expect(f.advice.sentence).toContain("You're fronting GY$8,000 of your GY$10,000 cash float");
  });

  it('the cockpit renders the server sentence and keeps the old copy only as a fallback', () => {
    const screen = readFileSync(path.join(__dirname, '..', '..', '..', 'mobile', 'src', 'modules', 'mover', 'screens', 'MoverHomeScreen.tsx'), 'utf8');
    expect(screen).toContain('{profile.float.advice?.sentence ? (');
    expect(screen).toContain('{profile.float.advice.sentence}');
    expect(screen).not.toMatch(/fronting GY\$/); // the words have one home
  });
});
