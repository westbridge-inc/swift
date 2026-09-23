import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LivenessService, assertShiftLiveness } from '../modules/safety/liveness.service';
import { syntheticLocationOwner } from './helpers/online-mover';

// [NO-AI · owner rule 2026-09-07] Identity Assurance §7.1 — the go-online selfie
// check — was a face comparison run by the identity provider. The provider is
// gone and Swift compares no faces, so the check is REMOVED, not dormant: the
// service has no check, the gate knows only the LOCK, and the multipart route
// refuses before it reads a body, so no selfie is ever collected for a check
// that cannot run. safety-liveness-midshift.test.ts grades §7.2 (gone) and §7.3
// (the lock, which stays).

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_750_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Live', lastName: `U${seq}`,
      roles, activeRole: roles[0]!,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: 'https://cdn.test/avatars/reference-face.jpg',
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'liv', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver(extra: Record<string, unknown> = {}) {
  const u = await makeUser(['MOVER'], extra);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `LIV ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('liveness'),
    },
  });
  return { ...u, driver };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.livenessCheck.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('assertShiftLiveness — the only identity gate left is the LOCK', () => {
  it('no lock → no gate: nothing about selfies, freshness or a feature flag stands between a verified mover and going online', () => {
    expect(() => assertShiftLiveness({ livenessLockedAt: null })).not.toThrow();
    // The routes pass the whole profile row, which still carries the legacy freshness column; it is ignored.
    expect(() => assertShiftLiveness({ livenessLockedAt: null, lastLivenessPassAt: null } as never)).not.toThrow();
    expect(() => assertShiftLiveness({ livenessLockedAt: null, lastLivenessPassAt: new Date(0) } as never)).not.toThrow();
  });

  it('a lock → 423 LIVENESS_LOCKED, whatever else the row says', () => {
    type Refusal = { statusCode?: number; code?: string; message?: string };
    let caught: Refusal | null = null;
    try { assertShiftLiveness({ livenessLockedAt: new Date() }); } catch (e) { caught = e as Refusal; }
    expect(caught).toMatchObject({ statusCode: 423, code: 'LIVENESS_LOCKED' });
    expect(caught?.message).toMatch(/contact support/i);
  });
});

describe('LivenessService — the shift selfie check is gone', () => {
  it('the service exposes no check and no sweep: only the §7.3 report remains', () => {
    const svc = new LivenessService(app.prisma, app.io) as unknown as Record<string, unknown>;
    expect(svc['check']).toBeUndefined();
    expect(svc['midshiftSweep']).toBeUndefined();
    expect(typeof svc['reportNotMyDriver']).toBe('function');
  });
});

describe('POST /api/v1/safety/liveness-check', () => {
  const REAL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  function multipartBody(filename: string, mime: string, content: Buffer) {
    const boundary = `----swift${nanoid(8)}`;
    const head = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  it('refuses with 410 LIVENESS_CHECK_REMOVED before reading the body: no row, no notification, the driver row untouched', async () => {
    const { userId, token, driver } = await makeDriver();
    const { payload, contentType } = multipartBody('shift.png', 'image/png', REAL_PNG);
    const res = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check?profile=DRIVER', payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('LIVENESS_CHECK_REMOVED');
    expect(res.json().error.message).toMatch(/Nothing was uploaded or recorded/);
    expect(await app.prisma.livenessCheck.count({ where: { userId } })).toBe(0);
    expect(await app.prisma.notification.count({ where: { userId } })).toBe(0);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after).toMatchObject({ lastLivenessPassAt: null, livenessLockedAt: null, livenessPromptDeadlineAt: null, isOnline: true });
  });

  it('is still an authenticated route: anonymous callers get 401, not the refusal', async () => {
    const anon = multipartBody('a.png', 'image/png', REAL_PNG);
    const res = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check', payload: anon.payload, headers: { 'content-type': anon.contentType } });
    expect(res.statusCode).toBe(401);
  });
});
