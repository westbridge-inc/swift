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
import type { KycProvider } from '../providers/kyc/kyc-provider';

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
      isOnline: true, isAvailable: true,
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

describe('LivenessService.check — the §7.1 outcome ladder', () => {
  it('PASS stamps the shift cache and satisfies the gate', async () => {
    const { userId, driver } = await makeDriver();
    const res = await svcCheck(userId, 'https://cdn.test/liveness/auto-approve.jpg');
    expect(res.outcome).toBe('PASS');
    expect(res.allowedOnline).toBe(true);
    const after = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after.lastLivenessPassAt).not.toBeNull();
    process.env['LIVENESS_REQUIRED'] = '1';
    try {
      expect(() => assertShiftLiveness(after)).not.toThrow();
    } finally {
      delete process.env['LIVENESS_REQUIRED'];
    }
  });

  it('BORDERLINE goes online but lands in the human review queue', async () => {
    const admin = await makeUser(['ADMIN']);
    const { userId, driver } = await makeDriver();
    const res = await svcCheck(userId, 'https://cdn.test/liveness/unmarked.jpg'); // sandbox → pending_manual
    expect(res.outcome).toBe('BORDERLINE');
    expect(res.allowedOnline).toBe(true);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).lastLivenessPassAt).not.toBeNull();
    const row = await app.prisma.livenessCheck.findUniqueOrThrow({ where: { id: res.checkId } });
    expect(row.reviewRequired).toBe(true);
    const page = await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: 'Liveness review needed' } });
    expect(page).not.toBeNull();
  });

  it('three consecutive FAILs lock the account, force it offline, and page ops (§7.1)', async () => {
    const { userId, driver } = await makeDriver();
    const reject = 'https://cdn.test/liveness/auto-reject.jpg';
    const first = await svcCheck(userId, reject);
    expect(first.outcome).toBe('FAIL');
    expect(first.attemptsLeft).toBe(2);
    const second = await svcCheck(userId, reject);
    expect(second.attemptsLeft).toBe(1);
    const third = await svcCheck(userId, reject);
    expect(third.attemptsLeft).toBe(0);

    const locked = await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(locked.livenessLockedAt).not.toBeNull();
    expect(locked.isOnline).toBe(false); // forced off NOW, not at next gate
    expect(locked.isAvailable).toBe(false);
    const userNote = await app.prisma.notification.findFirst({ where: { userId, type: 'SAFETY', title: 'Identity check failed' } });
    expect(userNote).not.toBeNull();

    // Locked = no more provider calls, only ops clears.
    await expect(svcCheck(userId, 'https://cdn.test/liveness/auto-approve.jpg')).rejects.toThrow(/contact support/i);
    process.env['LIVENESS_REQUIRED'] = '1';
    try {
      expect(() => assertShiftLiveness(locked)).toThrow(/contact support/i);
    } finally {
      delete process.env['LIVENESS_REQUIRED'];
    }
  });

  it('a PASS after two FAILs resets the consecutive count — no lock on old history', async () => {
    const { userId, driver } = await makeDriver();
    const reject = 'https://cdn.test/liveness/auto-reject.jpg';
    await svcCheck(userId, reject);
    await svcCheck(userId, reject);
    await svcCheck(userId, 'https://cdn.test/liveness/auto-approve.jpg'); // recovers
    const res = await svcCheck(userId, reject); // a NEW first failure
    expect(res.attemptsLeft).toBe(2);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).livenessLockedAt).toBeNull();
  });

  it('analyzer outage: default policy fails OPEN with a flag; FAIL_CLOSED blocks', async () => {
    const broken: KycProvider = {
      verifyIdentity: async () => { throw new Error('analyzer 503'); },
      verifyDocument: async () => { throw new Error('analyzer 503'); },
      getStatus: async () => 'pending_manual',
    };
    const { userId, driver } = await makeDriver();
    const svc = new LivenessService(app.prisma, app.io, broken);

    const open = await svc.check({ userId, profile: 'DRIVER', selfieUrl: 'https://cdn.test/liveness/x.jpg' });
    expect(open.outcome).toBe('ERROR_FAIL_OPEN'); // a vetted driver isn't locked out by a vendor outage
    expect(open.allowedOnline).toBe(true);
    expect((await app.prisma.livenessCheck.findUniqueOrThrow({ where: { id: open.checkId } })).reviewRequired).toBe(true);

    process.env['LIVENESS_ANALYZER_OUTAGE_POLICY'] = 'FAIL_CLOSED';
    try {
      await app.prisma.driver.update({ where: { id: driver.id }, data: { lastLivenessPassAt: null } });
      const closed = await svc.check({ userId, profile: 'DRIVER', selfieUrl: 'https://cdn.test/liveness/y.jpg' });
      expect(closed.outcome).toBe('ERROR_FAIL_CLOSED');
      expect(closed.allowedOnline).toBe(false);
      expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).lastLivenessPassAt).toBeNull();
    } finally {
      delete process.env['LIVENESS_ANALYZER_OUTAGE_POLICY'];
    }
  });

  it('no signup selfie → the check refuses (there is nothing trusted to match against)', async () => {
    const { userId } = await makeDriver({ avatar: null, selfieCapturedAt: null });
    await expect(svcCheck(userId, 'https://cdn.test/liveness/auto-approve.jpg')).rejects.toThrow(/profile selfie/i);
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

  it('uploads the selfie, runs the check, and records the auditable row', async () => {
    const { userId, token } = await makeDriver();
    const { payload, contentType } = multipartBody('shift.png', 'image/png', REAL_PNG);
    const res = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check?profile=DRIVER', payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const { checkId, outcome } = res.json().data;
    const row = await app.prisma.livenessCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(row.userId).toBe(userId);
    expect(row.profile).toBe('DRIVER');
    expect(row.selfieUrl).toContain(`liveness/${userId}`);
    expect(['PASS', 'BORDERLINE', 'FAIL', 'ERROR_FAIL_OPEN']).toContain(outcome);
  });

  it('rejects a non-image payload and unauthenticated calls', async () => {
    const { token } = await makeDriver();
    const bad = multipartBody('evil.png', 'image/png', Buffer.from('#!/bin/sh echo pwned'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check', payload: bad.payload, headers: { 'content-type': bad.contentType, authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(400);
    const anon = multipartBody('a.png', 'image/png', REAL_PNG);
    const res2 = await app.inject({ method: 'POST', url: '/api/v1/safety/liveness-check', payload: anon.payload, headers: { 'content-type': anon.contentType } });
    expect(res2.statusCode).toBe(401);
  });
});
