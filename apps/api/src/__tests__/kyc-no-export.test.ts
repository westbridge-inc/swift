import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { DiditKycProvider } from '../providers/kyc/didit-provider';
import { IdAnalyzerKycProvider } from '../providers/kyc/id-analyzer-provider';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';

let app: FastifyInstance;
let reviewerId: string;
const ids: string[] = [];
const phoneBase = 592_021_000_000 + Math.floor(Math.random() * 900_000);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'human-only-kyc-test');

async function applicant(role: 'ADMIN' | 'MOVER' | 'CUSTOMER') {
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + ids.length}`, firstName: 'Synthetic', lastName: 'Applicant',
    countryCode: 'GY', roles: [role], activeRole: role, trustLevel: 'L1', isPhoneVerified: true,
    ...(role === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}),
    ...(role === 'MOVER' ? { rider: { create: { riderType: 'DELIVERY', vehicleType: 'BICYCLE' } } } : {}),
  } });
  ids.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  return user.id;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  reviewerId = await system(() => applicant('ADMIN'));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((doc) => doc.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  await app.close();
});

describe('configured human-review approval flow never exports document references', () => {
  it.each(['0', '1'])('zero external calls through intake, approval and rejection with biometric flag %s', async (flag) => {
    vi.stubEnv('KYC_PROVIDER', 'manual');
    vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', flag);
    const calls = [DiditKycProvider, IdAnalyzerKycProvider].flatMap((adapter) => [
      vi.spyOn(adapter.prototype, 'verifyIdentity').mockResolvedValue({ status: 'approved', referenceToken: 'unexpected-external-call' }),
      vi.spyOn(adapter.prototype, 'verifyDocument').mockResolvedValue({ status: 'approved', referenceToken: 'unexpected-external-call' }),
      vi.spyOn(adapter.prototype, 'getStatus').mockResolvedValue('approved'),
    ]);
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    await system(async () => {
      const mover = await applicant('MOVER');
      const id = await service.submitDocument(mover, 'MOVER', 'national_id', await ownedVerificationFixture(app.prisma, mover), 'v1');
      const clearance = await service.submitDocument(mover, 'MOVER', 'police_clearance', await ownedVerificationFixture(app.prisma, mover), 'v1');
      const customer = await applicant('CUSTOMER');
      const identity = await service.submitIdentity(customer, await ownedVerificationFixture(app.prisma, customer), await ownedVerificationFixture(app.prisma, customer, 'selfie'), 'v1');
      for (const doc of [id, clearance, identity]) {
        expect(doc).toMatchObject({ status: 'PENDING', reviewedBy: null });
        expect(doc.kycRef).toMatch(/^manual_/);
        expect(await app.prisma.reviewCase.count({ where: { submissionId: doc.id, closedAt: null } })).toBe(1);
      }
      expect(await service.approveDocument(id.id, reviewerId)).toMatchObject({ status: 'APPROVED', reviewedBy: reviewerId });
      expect(await service.rejectDocument(clearance.id, reviewerId, 'The document is unreadable; please submit it again.')).toMatchObject({ status: 'REJECTED', reviewedBy: reviewerId });
    });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });
});
