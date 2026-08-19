import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  convertUsdToLocal,
  roundToIncrement,
  formatMoney,
  validateNewRate,
  noticeRequired,
  rateStaleness,
  dualDisplay,
} from '../modules/billing/fx';

// USD Platform Pricing — Part 14 merge gates on the pure core + Part 12/20
// governance over HTTP: the conversion table (HALF_UP at every increment),
// the five-currency formatter law (snapshot), the fat-finger guard's typed
// confirmation, append-only price-book semantics, and the pure preview.

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_004_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeAdmin() {
  seq += 1;
  const user = await app.prisma.user.create({
    // SUPER_ADMIN: FX/price-book governance is founder-only by design
    // (platformControlGuard → assertFounderAccess) — a tenant-local ADMIN
    // correctly gets 403 since the integrity-founder-guard work (#632).
    data: { phone: `+${phoneBase + seq}`, firstName: 'Fx', lastName: `A${seq}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'fx', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { token };
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const put = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'PUT', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.fxRate.deleteMany({ where: { quote: 'GYD', setByUserId: { in: userIds } } });
  await app.prisma.fxRate.deleteMany({ where: { quote: 'TTD', setByUserId: { in: userIds } } });
  await app.prisma.priceBookEntry.deleteMany({ where: { tier: { startsWith: 'FXTEST' } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the conversion law (Part 11/20 — one pure function)', () => {
  it('the spec example and the HALF_UP table across increments', () => {
    // US$25.00 × 208.72 = 5,218.00 → GY$5,200 at increment 100.
    expect(convertUsdToLocal(25, 208.72, 100)).toEqual({ amountLocal: 5200, minClamped: false });
    // Exact half rounds UP at every increment.
    expect(roundToIncrement(150, 100)).toBe(200);
    expect(roundToIncrement(25, 50)).toBe(50);
    expect(roundToIncrement(0.5, 1)).toBe(1);
    // Below half rounds down; above rounds up.
    expect(roundToIncrement(149.99, 100)).toBe(100);
    expect(roundToIncrement(150.01, 100)).toBe(200);
    // TTD (increment 1) and JMD (increment 50) shapes.
    expect(convertUsdToLocal(25, 6.79, 1).amountLocal).toBe(170);
    expect(convertUsdToLocal(25, 156.4, 50).amountLocal).toBe(3900);
  });

  it('the minimum clamp — a zero charge is impossible by construction', () => {
    const r = convertUsdToLocal(0.1, 2, 100); // 0.2 → rounds to 0 → clamps
    expect(r.amountLocal).toBe(100);
    expect(r.minClamped).toBe(true);
  });

  it('the formatter law — all five currencies, exact (snapshot)', () => {
    expect(formatMoney(25, 'USD')).toBe('US$25.00');
    expect(formatMoney(5200, 'GYD')).toBe('GY$5,200');
    expect(formatMoney(170, 'TTD')).toBe('TT$170.00');
    expect(formatMoney(3900, 'JMD')).toBe('J$3,900');
    expect(formatMoney(50, 'BBD')).toBe('Bds$50.00');
    expect(dualDisplay(25, 5200, 'GYD')).toBe('US$25.00 / week · GY$5,200 this week');
  });

  it('rate validation: positivity, ≤6 decimals, the 20% typed-confirmation line', () => {
    expect(validateNewRate(0, null).ok).toBe(false);
    expect(validateNewRate(1.1234567, null).ok).toBe(false);
    expect(validateNewRate(208.72, null).requiresTypedConfirmation).toBe(false);
    expect(validateNewRate(250, 208.72).requiresTypedConfirmation).toBe(false); // ~19.8%
    expect(validateNewRate(2087.2, 208.72).requiresTypedConfirmation).toBe(true); // the fat finger
  });

  it('the >2% notice trigger — 1.9% silent, 2.1% notices', () => {
    expect(noticeRequired(5200, 5298)).toBe(false); // 1.88%
    expect(noticeRequired(5200, 5310)).toBe(true); // 2.12%
  });

  it('staleness nags at 30/90 days, never blocks', () => {
    expect(rateStaleness(new Date())).toBe('FRESH');
    expect(rateStaleness(new Date(Date.now() - 31 * 86_400_000))).toBe('STALE_30D');
    expect(rateStaleness(new Date(Date.now() - 91 * 86_400_000))).toBe('STALE_90D');
  });
});

describe('rate governance over HTTP (Part 12/20)', () => {
  it('append-only rates; the fat-finger guard demands the typed quote and spells the change in words', async () => {
    const admin = await makeAdmin();
    const first = await post('/api/v1/admin/billing/fx-rates', { quote: 'GYD', rate: 208.72 }, admin.token);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.staleness ?? 'FRESH').toBeTruthy();

    // 10× fat finger — refused with the delta in words (acceptance #15).
    const fat = await post('/api/v1/admin/billing/fx-rates', { quote: 'GYD', rate: 2087.2 }, admin.token);
    expect(fat.statusCode).toBe(409);
    expect(fat.json().error.message).toContain('changes from');
    expect(fat.json().error.message).toContain('confirmQuote');

    // Typed confirmation applies it — append-only: both rows exist.
    const confirmed = await post('/api/v1/admin/billing/fx-rates', { quote: 'GYD', rate: 2087.2, confirmQuote: 'GYD' }, admin.token);
    expect(confirmed.statusCode).toBe(200);
    const rows = await get('/api/v1/admin/billing/fx-rates?quote=GYD', admin.token);
    expect((rows.json().data as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('price-book set keeps history (deactivate + create) and fx-preview computes the plan table purely', async () => {
    const admin = await makeAdmin();
    const tier = `FXTEST-${nanoid(4)}`;
    await put('/api/v1/admin/billing/price-book', { role: 'VENDOR', tier, amountUsd: 25 }, admin.token);
    await put('/api/v1/admin/billing/price-book', { role: 'VENDOR', tier, amountUsd: 30 }, admin.token);
    const book = await get('/api/v1/admin/billing/price-book', admin.token);
    const mine = (book.json().data as Array<{ tier: string | null; active: boolean; amountUsd: number }>).filter((e) => e.tier === tier);
    expect(mine).toHaveLength(2); // history preserved
    expect(mine.filter((e) => e.active)).toHaveLength(1);
    expect(mine.find((e) => e.active)!.amountUsd).toBe(30);

    const preview = await get('/api/v1/admin/billing/fx-preview?quote=TTD&rate=6.79', admin.token);
    expect(preview.statusCode).toBe(200);
    const plan = (preview.json().data.plans as Array<{ tier: string | null; nextLocal: number; display: string }>).find((p) => p.tier === tier);
    expect(plan).toBeTruthy();
    // US$30 × 6.79 = 203.7 → TT$204 at increment 1 (no TTD tenant row → 1).
    expect(plan!.nextLocal).toBe(204);
    expect(plan!.display).toBe('TT$204.00');
    // Preview committed nothing.
    expect(await app.prisma.fxRate.count({ where: { quote: 'TTD', rate: 6.79 } })).toBe(0);
  });
});
