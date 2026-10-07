/**
 * [Owner, 1 Oct · truth] The partner sign-up told the owner his ID was
 * "Face-matched against your profile selfie" while the server's face-matching
 * is switched off (FD-D5 — off by default). The apps now show that line only
 * for a document GET /verification/status names in `faceMatchDocTypes`. This
 * pins what the server names:
 *   - nothing while the switch is off, whatever the engine;
 *   - nothing with an engine that compares no faces (the on-shore manual
 *     review, the sandbox) even with the switch on;
 *   - with the switch on and an engine that compares faces (Didit, ID
 *     Analyzer): exactly the identity documents on that checklist — the
 *     documents the submit path sends down its face-match leg.
 * Read-only: the submit path's leg and the flag are decided by one predicate,
 * and nothing about how a document is verified changes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService, identityFaceMatchLeg } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider, SandboxKycProvider, type KycProvider } from '../providers/kyc/kyc-provider';
import { DiditKycProvider } from '../providers/kyc/didit-provider';
import { IdAnalyzerKycProvider } from '../providers/kyc/id-analyzer-provider';

let app: FastifyInstance;
const users: string[] = [];
let ownerId = '';
let ownerToken = '';
let riderId = '';
let riderToken = '';
// Unique per run (identity rows outlive deleted test users).
const phoneBase = 592_617_000_000 + Math.floor(Math.random() * 8_000_000);

async function user(n: number, roles: Array<'CUSTOMER' | 'VENDOR_OWNER' | 'MOVER' | 'RIDER'>, activeRole: 'VENDOR_OWNER' | 'RIDER') {
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + n}`, firstName: 'Truth', lastName: `Face${n}`, countryCode: 'GY',
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'face-match-truth', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { id: u.id, token };
}

/** GET /api/v1/verification/status as the signed-in partner. */
async function status(token: string, role: string, vehicleType?: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/verification/status?role=${role}${vehicleType ? `&vehicleType=${vehicleType}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { checklist: string[]; optional: string[]; faceMatchDocTypes?: unknown };
}

const service = (kyc: KycProvider) => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
/** The engines whose identity check compares the document's face with the selfie. Constructing one makes no request. */
function faceEngines(): KycProvider[] {
  vi.stubEnv('DIDIT_API_KEY', 'test');
  vi.stubEnv('ID_ANALYZER_API_KEY', 'test');
  return [new DiditKycProvider(), new IdAnalyzerKycProvider()];
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  ({ id: ownerId, token: ownerToken } = await user(1, ['CUSTOMER', 'VENDOR_OWNER'], 'VENDOR_OWNER'));
  ({ id: riderId, token: riderToken } = await user(2, ['CUSTOMER', 'MOVER', 'RIDER'], 'RIDER'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (users.length) {
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  await app.close();
});

describe('GET /verification/status names the documents the server compares with the profile selfie — and only those', () => {
  it('face-matching off (the default): nothing, for a business owner and for a rider — whatever the engine', async () => {
    vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', '');

    const business = await status(ownerToken, 'RESTAURANT');
    expect(business.checklist).toContain('owner_national_id');
    expect(business.faceMatchDocTypes).toEqual([]);

    const rider = await status(riderToken, 'MOVER', 'MOTORCYCLE');
    // [VERIFY-DOCS · ruling 4] a licence holder's national ID is optional — still offered, still an identity document
    expect([...rider.checklist, ...rider.optional]).toContain('national_id');
    expect(rider.faceMatchDocTypes).toEqual([]);

    for (const engine of faceEngines()) {
      expect((await service(engine).getStatus(ownerId, 'RESTAURANT')).faceMatchDocTypes, engine.engine?.name).toEqual([]);
      expect((await service(engine).getStatus(riderId, 'MOVER', 'MOTORCYCLE')).faceMatchDocTypes, engine.engine?.name).toEqual([]);
    }
  });

  it('face-matching on, with an engine that compares faces: exactly the identity documents on the checklist', async () => {
    vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', '1');

    for (const engine of faceEngines()) {
      const business = await service(engine).getStatus(ownerId, 'RESTAURANT');
      expect(business.checklist.length, 'the checklist holds more than the ID').toBeGreaterThan(1);
      expect(business.faceMatchDocTypes, engine.engine?.name).toEqual(['owner_national_id']);

      const rider = await service(engine).getStatus(riderId, 'MOVER', 'MOTORCYCLE');
      expect(rider.checklist.length).toBeGreaterThan(1);
      expect(rider.faceMatchDocTypes, engine.engine?.name).toEqual(['national_id']);
    }
  });

  it('face-matching on, but the engine compares no faces (the on-shore manual review, the sandbox): nothing', async () => {
    vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', '1');

    // The route's own engine in this suite is the sandbox (vitest.config pins KYC_PROVIDER=sandbox).
    expect((await status(ownerToken, 'RESTAURANT')).faceMatchDocTypes).toEqual([]);
    expect((await status(riderToken, 'MOVER', 'MOTORCYCLE')).faceMatchDocTypes).toEqual([]);

    for (const engine of [new ManualReviewKycProvider(), new SandboxKycProvider()]) {
      expect((await service(engine).getStatus(ownerId, 'RESTAURANT')).faceMatchDocTypes, engine.engine?.name).toEqual([]);
    }
  });

  it('one predicate: the submit path takes its face-match leg for exactly the documents the flag can name', () => {
    for (const docType of ['owner_national_id', 'national_id']) {
      expect(identityFaceMatchLeg(docType, { FEATURE_BIOMETRIC_FACE_MATCH: '1' }), docType).toBe(true);
      expect(identityFaceMatchLeg(docType, {}), docType).toBe(false);
      expect(identityFaceMatchLeg(docType, { FEATURE_BIOMETRIC_FACE_MATCH: '0' }), docType).toBe(false);
    }
    for (const docType of ['business_registration', 'tin_certificate', 'storefront_photo', 'drivers_licence', 'police_clearance']) {
      expect(identityFaceMatchLeg(docType, { FEATURE_BIOMETRIC_FACE_MATCH: '1' }), docType).toBe(false);
    }
    // The submit path branches on that same predicate, so the flag cannot drift from what runs.
    const service = readFileSync(join(__dirname, '..', 'modules', 'verification', 'verification.service.ts'), 'utf8');
    expect(service).toMatch(/if \(identityFaceMatchLeg\(docType\)\) \{\s*const selfieUrl = await resolveSignupSelfie\(this\.prisma, userId\);/);
    expect(service).not.toMatch(/IDENTITY_FACE_MATCH_DOCS\.has\(docType\) && biometricFaceMatchEnabled\(\)/);
  });
});
