import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { assessFix, arrivalCorroboration, flagSentence, traceKey, recentTrace, CORROBORATION_WINDOW_MS } from '../modules/dispatch/gps-plausibility';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// [ALG-15] GPS plausibility. Every GPS-money guarantee — arrival evidence,
// handover GPS, waiting-time money — rests on a fix a device reported. The
// client signal is reported honestly; the server does the physics. The
// consequence is a FLAG (an AlgoDecision row for a reviewer), never a
// penalty; absence is never fraud; and the tell never leaks.
// ---------------------------------------------------------------------------

const GT = { lat: 6.8013, lng: -58.1551 };
const at = (ms: number) => new Date(1_800_000_000_000 + ms);

describe('physics: what a device cannot honestly do', () => {
  it('a teleport — 5 km in 30 s — is an implausible speed', () => {
    const a = assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.045, lng: GT.lng, at: at(30_000) });
    expect(a.signals).toEqual(['IMPLAUSIBLE_SPEED']);
    expect(a.speedKmh).toBeGreaterThan(500);
    expect(a.distanceM).toBeGreaterThan(4_900);
  });

  it('a motorbike at 60 km/h is fine; the threshold is the config value', () => {
    // ~1 km in 60 s
    const ride = assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.009, lng: GT.lng, at: at(60_000) });
    expect(ride.signals).toEqual([]);
    expect(ride.speedKmh).toBeGreaterThan(50);
    expect(ride.speedKmh).toBeLessThan(70);
    expect(assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.009, lng: GT.lng, at: at(60_000) }, { maxPlausibleKmh: 50 }).signals).toEqual(['IMPLAUSIBLE_SPEED']);
    expect(ALGO_DEFAULTS['gps.maxPlausibleKmh']).toBe(140);
    expect(ALGO_DEFAULTS['ALG-15.enabled']).toBe(true);
  });

  it('jitter is not a teleport: fixes under 50 m apart are never judged on speed, whatever the clock says', () => {
    // 40 m in 1 s would be 144 km/h — but it is jitter, and it is ignored.
    expect(assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.00036, lng: GT.lng, at: at(1_000) }).signals).toEqual([]);
    expect(assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.00036, lng: GT.lng, at: at(10_000) }).speedKmh).toBeNull();
    // ...while 30 km four seconds after the last fix is the teleport it is.
    expect(assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.27, lng: GT.lng, at: at(4_000) }).signals).toEqual(['IMPLAUSIBLE_SPEED']);
  });

  it('no previous fix is no verdict — absence is not fraud', () => {
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0) })).toEqual({ signals: [], speedKmh: null, distanceM: null, elapsedS: null });
  });

  it('the device saying "mock provider" is a signal; an honest absence is nothing', () => {
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0), mocked: true }).signals).toEqual(['MOCK_PROVIDER']);
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0), mocked: false }).signals).toEqual([]);
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0), mocked: null }).signals).toEqual([]);
  });

  it('perfect accuracy is more suspicious than noise', () => {
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0), accuracyM: 0.4 }).signals).toEqual(['PERFECT_ACCURACY']);
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0), accuracyM: 12 }).signals).toEqual([]);
    expect(assessFix(null, { lat: GT.lat, lng: GT.lng, at: at(0), accuracyM: null }).signals).toEqual([]);
  });

  it('the reviewer sentence names the physics, never a person', () => {
    const a = assessFix({ lat: GT.lat, lng: GT.lng, at: at(0) }, { lat: GT.lat + 0.045, lng: GT.lng, at: at(30_000), mocked: true });
    expect(flagSentence(a.signals, a)).toMatch(/^Position needs a look: \d+ m in 30s \(\d+ km\/h\); the device reported a mock location provider\.$/);
  });
});

describe('corroboration: a claimed arrival with nothing behind it', () => {
  it('fewer than two fixes in the ten minutes before the claim is uncorroborated — an absence, recorded as one', () => {
    const declared = at(20 * 60_000);
    const trace = [{ at: declared.getTime() - 60_000 }, { at: declared.getTime() - 5 * 60_000 }, { at: declared.getTime() - 30 * 60_000 }];
    expect(arrivalCorroboration(trace, declared)).toEqual({ corroborated: true, fixesInWindow: 2 });
    expect(arrivalCorroboration([{ at: declared.getTime() - 30 * 60_000 }], declared)).toEqual({ corroborated: false, fixesInWindow: 0 });
    expect(CORROBORATION_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

describe('over HTTP: a flag is a row, the fix is still accepted, and nothing leaks', () => {
  const PHONE_PREFIX = '+59200661';
  const DAY = 24 * 60 * 60 * 1000;
  let app: FastifyInstance;
  const userIds: string[] = [];

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-15', subjectId: { in: riders.map((r) => r.id) } } });
    for (const r of riders) await app.redis.del(traceKey('RIDER', r.id), `gps:flagged:RIDER:${r.id}:FLAGGED`, `rider:location_db_ts:${r.id}`);
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  async function onlineRider(n: number) {
    const user = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}${String(n).padStart(2, '0')}`, firstName: 'Gps', lastName: `Rider${n}`, roles: ['RIDER' as UserRole], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
    const session = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(40), deviceId: 'gps', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, isAvailable: true, locationSessionId: session.id, currentLat: GT.lat, currentLng: GT.lng, lastLocationUpdate: new Date(Date.now() - 30_000) } });
    return { riderId: rider.id, token };
  }
  const put = (token: string, body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/v1/rider/location', payload: body, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const settle = () => new Promise((r) => setTimeout(r, 150));

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

  it('a teleport is accepted like any fix, writes one ALG-15 row, and the response never names the signal', async () => {
    const r = await onlineRider(1);
    const res = await put(r.token, { latitude: GT.lat + 0.045, longitude: GT.lng, accuracy: 8 });
    expect(res.statusCode, res.body).toBe(200);
    // With no live leg the route answers { success: true } — accepted, nothing refused.
    expect(res.json().success).toBe(true);
    expect(res.json().data?.accepted).not.toBe(false);
    expect(res.payload).not.toMatch(/mock|plausib|teleport|speed|flag/i);
    await settle();
    const rows = await app.prisma.algoDecision.findMany({ where: { algo: 'ALG-15', subjectId: r.riderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('FLAGGED');
    expect((rows[0]!.inputs as { signals: string[] }).signals).toEqual(['IMPLAUSIBLE_SPEED']);
    // The trace now holds the fix, for the arrival corroboration to read.
    expect((await recentTrace(app.redis, traceKey('RIDER', r.riderId), 0)).length).toBe(1);
  });

  it('a second flag inside the cooldown does not write a second row — a bad receiver cannot flood the log', async () => {
    const r = await onlineRider(2);
    await put(r.token, { latitude: GT.lat + 0.045, longitude: GT.lng });
    await settle();
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentLat: GT.lat, currentLng: GT.lng, lastLocationUpdate: new Date(Date.now() - 30_000) } });
    await put(r.token, { latitude: GT.lat - 0.045, longitude: GT.lng });
    await settle();
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-15', subjectId: r.riderId } })).toBe(1);
  });

  it('an old client with no accuracy or mock flag is accepted, and an honest fix writes nothing', async () => {
    const r = await onlineRider(3);
    const res = await put(r.token, { latitude: GT.lat + 0.001, longitude: GT.lng });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    await settle();
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-15', subjectId: r.riderId } })).toBe(0);
  });

  it('the device saying "mocked" is recorded as a flag — and the fix is still accepted', async () => {
    const r = await onlineRider(4);
    const res = await put(r.token, { latitude: GT.lat + 0.001, longitude: GT.lng, mocked: true, accuracy: 5 });
    expect(res.json().success).toBe(true);
    await settle();
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: 'ALG-15', subjectId: r.riderId } });
    expect((row?.inputs as { signals: string[] }).signals).toEqual(['MOCK_PROVIDER']);
  });
});
