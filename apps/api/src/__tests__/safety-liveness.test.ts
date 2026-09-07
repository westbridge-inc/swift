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

// [FD-D5 · 2026-09-07] The switch is OFF by default now; this suite characterises the ON behaviour.
process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = '1';

// Identity Assurance M5 (safety spec §7.1) — the go-online liveness ladder.
// The provider tri-state IS the ladder: approved→PASS, pending_manual→
// BORDERLINE (online + human review), rejected→FAIL (3rd consecutive locks).
// Analyzer outage applies the tenant policy (default FAIL_OPEN_FLAGGED).
// The whole feature is DORMANT until LIVENESS_REQUIRED=1 — proven here and,
// implicitly, by every existing go-online test in the suite running with the
// flag off.

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

/** Service wired to the sandbox provider's deterministic URL markers. */
const service = () => new LivenessService(app.prisma, app.io);
const svcCheck = (userId: string, selfieUrl: string) =>
  service().check({ userId, profile: 'DRIVER', selfieUrl });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['LIVENESS_REQUIRED'];
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
  delete process.env['LIVENESS_REQUIRED'];
  delete process.env['LIVENESS_ANALYZER_OUTAGE_POLICY'];
  await app.prisma.livenessCheck.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('assertShiftLiveness — the go-online gate (§7.1)', () => {
  it('is a no-op while the tenant has liveness OFF (dormant, like every config-gated engine)', () => {
    delete process.env['LIVENESS_REQUIRED'];
    expect(() => assertShiftLiveness({ lastLivenessPassAt: null, livenessLockedAt: null })).not.toThrow();
  });

  it('with liveness ON: stale → 428 (client runs the check), fresh PASS → allowed, lock → 423', () => {
    process.env['LIVENESS_REQUIRED'] = '1';
    try {
      expect(() => assertShiftLiveness({ lastLivenessPassAt: null, livenessLockedAt: null })).toThrow(/selfie check/i);
      const thirteenHoursAgo = new Date(Date.now() - 13 * 3_600_000);
      expect(() => assertShiftLiveness({ lastLivenessPassAt: thirteenHoursAgo, livenessLockedAt: null })).toThrow(/selfie check/i);
      const anHourAgo = new Date(Date.now() - 3_600_000);
      expect(() => assertShiftLiveness({ lastLivenessPassAt: anHourAgo, livenessLockedAt: null })).not.toThrow();
      expect(() => assertShiftLiveness({ lastLivenessPassAt: anHourAgo, livenessLockedAt: new Date() })).toThrow(/contact support/i);
    } finally {
      delete process.env['LIVENESS_REQUIRED'];
    }
  });
});

// ---------------------------------------------------------------------------
// [NO-AI · owner directive 2026-09-07] THE OUTCOME LADDER TESTED A CAPABILITY
// THAT NO LONGER EXISTS.
//
// A liveness check IS a face match, and face matching ran inside the KYC
// providers the owner removed. There is no PASS, no FAIL and no BORDERLINE to
// reach any more, so the ladder that graded them is replaced — not deleted
// quietly — by the contract that took its place.
//
// The old code did something worse than stop working. `biometricFaceMatchEnabled`
// has defaulted OFF since the founder's FD-D5 decision, so on current `main`
// every check already threw, was caught as a PROVIDER ERROR, and paged ops with
// "Face-match provider errored — investigate the provider." There is no provider
// to investigate. It also pushed each mover into a retro-review queue and, on a
// FAIL_CLOSED tenant, could block them from going online over a capability
// Swift itself had switched off.
//
// An absent capability is not an outage, and these prove it says so.
// ---------------------------------------------------------------------------
describe('[NO-AI] a liveness check is honestly unavailable, not a fake outage', () => {
  it('refuses with LIVENESS_UNAVAILABLE and records nothing', async () => {
    const { userId, driver } = await makeDriver();
    const before = await app.prisma.livenessCheck.count({ where: { userId } });

    await expect(svcCheck(userId, 'https://cdn.test/liveness/auto-approve.jpg'))
      .rejects.toMatchObject({ statusCode: 503, code: 'LIVENESS_UNAVAILABLE' });

    expect(await app.prisma.livenessCheck.count({ where: { userId } }), 'no row is written').toBe(before);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after.livenessLockedAt, 'nobody is locked out over a check that cannot run').toBeNull();
    expect(after.lastLivenessPassAt, 'and nothing is stamped as passed').toBeNull();
  });

  it('pages NOBODY — there is no provider outage to investigate', async () => {
    const admin = await makeUser(['ADMIN']);
    const { userId } = await makeDriver();
    await expect(svcCheck(userId, 'https://cdn.test/liveness/unmarked.jpg')).rejects.toMatchObject({ code: 'LIVENESS_UNAVAILABLE' });

    const pages = await app.prisma.notification.count({
      where: { userId: admin.userId, OR: [{ title: { contains: 'Liveness' } }, { data: { path: ['kind'], equals: 'liveness_outage' } }] },
    });
    expect(pages, 'a removed capability must not raise an operational alarm').toBe(0);
  });

  it('the environment variable cannot bring it back', async () => {
    // The flag used to gate a real face-match call. With both adapters deleted
    // there is nothing behind it, and a switch that appears to enable a missing
    // capability is worse than no switch at all.
    const { userId } = await makeDriver();
    process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = '1';
    try {
      await expect(svcCheck(userId, 'https://cdn.test/liveness/auto-approve.jpg'))
        .rejects.toMatchObject({ code: 'LIVENESS_UNAVAILABLE' });
    } finally {
      delete process.env['FEATURE_BIOMETRIC_FACE_MATCH'];
    }
  });
});

describe('POST /api/v1/safety/liveness-check (multipart)', () => {
  const REAL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  function multipartBody(filename: string, mime: string, content: Buffer) {
    const boundary = `----swift${nanoid(8)}`;
    const head = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  it('[NO-AI] refuses BEFORE the selfie is read or stored — and stores nothing', async () => {
    // The order matters and is the point. Collecting a selfie for a check that
    // cannot run is biometric data gathered for no purpose, which the DPA 2023
    // minimisation duty forbids and which deleting it afterwards does not undo.
    const { userId, token } = await makeDriver();
    const { payload, contentType } = multipartBody('shift.png', 'image/png', REAL_PNG);
    const res = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check?profile=DRIVER', payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(503);
    expect(res.json().error?.code ?? res.json().code).toBe('LIVENESS_UNAVAILABLE');
    expect(await app.prisma.livenessCheck.count({ where: { userId } }), 'no auditable row for a check that never happened').toBe(0);
  });

  it('[NO-AI] the refusal does not become a hole in the upload guards', async () => {
    // An unauthenticated caller must still be refused as unauthenticated —
    // the new 503 must not short-circuit authentication.
    const anon = multipartBody('a.png', 'image/png', REAL_PNG);
    const res2 = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check', payload: anon.payload, headers: { 'content-type': anon.contentType } });
    expect(res2.statusCode).toBe(401);
  });
});
