import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';

// ---------------------------------------------------------------------------
// [REPLACE-PENDING · owner request 8 Oct 2026 — "can't change a submitted document if I accidentally sent the
// wrong one"] A newer copy uploaded while the earlier one still waits for review replaces it: the earlier copy is
// kept as SUPERSEDED (never deleted), its review case closes, the queue shows only the newest copy (with a fresh
// case), a reviewer holding the old copy is told it was replaced, and the applicant sees "Replaced — waiting for
// review". An APPROVED document stays locked (renewal rules unchanged); a rejected copy stays as it was.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let service: VerificationService;
let reviewerId: string;
const users: string[] = [];
const phoneBase = 592_078_000_000 + Math.floor(Math.random() * 900_000);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'document-replace-pending-test');

async function mover() {
  return system(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Rider', roles: ['MOVER', 'RIDER'], activeRole: 'RIDER',
      lastMoverRole: 'RIDER', countryCode: 'GY', isPhoneVerified: true,
    } });
    users.push(user.id);
    await signupSelfieFixture(app.prisma, user.id);
    await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } });
    const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid() });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    return { userId: user.id, token };
  });
}
const upload = async (userId: string) => system(async () => service.submitDocument(userId, 'MOVER', 'national_id', await ownedVerificationFixture(app.prisma, userId), 'test-v1'));
const read = (id: string) => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } });
const openCases = (id: string) => app.prisma.reviewCase.findMany({ where: { submissionId: id, closedAt: null } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const reviewer = await system(() => app.prisma.user.create({ data: {
    phone: `+${phoneBase + 899_999}`, firstName: 'Synthetic', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  users.push(reviewer.id); reviewerId = reviewer.id;
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    const ids = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: ids } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('replace a document while it waits for review', () => {
  it('the newer copy replaces the waiting one: kept as SUPERSEDED, its case closed, one fresh case for the newest', async () => {
    const m = await mover();
    const first = await upload(m.userId);
    expect(first).toMatchObject({ status: 'PENDING', state: 'REVIEW_QUEUED' });
    const second = await upload(m.userId);
    expect(second).toMatchObject({ status: 'PENDING', state: 'REVIEW_QUEUED' });
    // Kept for audit, never deleted, and no longer waiting under any status-only reading.
    expect(await read(first.id)).toMatchObject({ state: 'SUPERSEDED', status: 'EXPIRED', reviewNote: expect.stringMatching(/^REPLACED/), fileUrl: first.fileUrl });
    expect(await openCases(first.id)).toHaveLength(0);
    expect(await openCases(second.id)).toHaveLength(1);
    // Only the newest copy waits (what the review queue lists: PENDING documents).
    const waiting = await app.prisma.verificationDocument.findMany({ where: { userId: m.userId, docType: 'national_id', status: 'PENDING' } });
    expect(waiting.map((d) => d.id)).toEqual([second.id]);
  });

  it('the applicant sees one copy, marked replaced and waiting for review', async () => {
    const m = await mover();
    await upload(m.userId);
    const second = await upload(m.userId);
    const res = await app.inject({ method: 'GET', url: '/api/v1/verification/status?role=MOVER', headers: { authorization: `Bearer ${m.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const docs = (res.json().data.documents as Array<{ id: string; docType: string; status: string; replaced?: boolean }>).filter((d) => d.docType === 'national_id');
    expect(docs).toEqual([expect.objectContaining({ id: second.id, status: 'PENDING', replaced: true })]);
  });

  it('a reviewer holding the old copy is told it was replaced; the newest copy waits unclaimed', async () => {
    const m = await mover();
    const first = await upload(m.userId);
    const [kase] = await openCases(first.id);
    await system(() => service.claimReviewCase(kase!.id, reviewerId));
    expect(await read(first.id)).toMatchObject({ state: 'IN_REVIEW' });
    const second = await upload(m.userId);
    expect(await read(first.id)).toMatchObject({ state: 'SUPERSEDED' });
    await expect(system(() => service.approveDocument(first.id, reviewerId))).rejects.toMatchObject({ code: 'DOCUMENT_REPLACED' });
    await expect(system(() => service.rejectDocument(first.id, reviewerId, 'Photo is unreadable', 'UNREADABLE'))).rejects.toMatchObject({ code: 'DOCUMENT_REPLACED' });
    expect(await read(first.id)).toMatchObject({ state: 'SUPERSEDED' });
    const [fresh] = await openCases(second.id);
    expect(fresh).toMatchObject({ assignedTo: null });
    expect(await system(() => service.approveDocument(second.id, reviewerId))).toMatchObject({ status: 'APPROVED' });
  });

  it('"replaced" belongs to the copy that replaced one: after replace, reject and a new upload, the new copy replaced nothing', async () => {
    const m = await mover();
    await upload(m.userId);
    const second = await upload(m.userId);
    await system(() => service.rejectDocument(second.id, reviewerId, 'Photo is unreadable', 'UNREADABLE'));
    const third = await upload(m.userId);
    const res = await app.inject({ method: 'GET', url: '/api/v1/verification/status?role=MOVER', headers: { authorization: `Bearer ${m.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const docs = (res.json().data.documents as Array<{ id: string; replaced?: boolean }>);
    const fresh = docs.find((d) => d.id === third.id);
    expect(fresh, 'the new copy is listed').toBeTruthy();
    expect(fresh!.replaced ?? false).toBe(false);
  });

  it('a copy that turns out OLDER than one already waiting never replaces the newer one (two uploads racing)', async () => {
    const m = await mover();
    // The newer copy's transaction committed first (its createdAt is later than the upload that lands now).
    const newer = await system(async () => app.prisma.verificationDocument.create({ data: {
      userId: m.userId, role: 'MOVER', docType: 'national_id', fileUrl: await ownedVerificationFixture(app.prisma, m.userId),
      status: 'PENDING', state: 'REVIEW_QUEUED', consentAt: new Date(), privacyNoticeVersion: 'test-v1', createdAt: new Date(Date.now() + 60_000),
    } }));
    await system(() => app.prisma.reviewCase.create({ data: { submissionId: newer.id, slaDueAt: new Date(Date.now() + 86_400_000) } }));
    const older = await upload(m.userId);
    expect(await read(newer.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING' });
    expect(await openCases(newer.id)).toHaveLength(1);
    expect(await read(older.id)).toMatchObject({ state: 'SUPERSEDED' });
    expect(await openCases(older.id)).toHaveLength(0);
  });

  it('an approved document stays locked; a rejected copy stays rejected when a new one is sent', async () => {
    const m = await mover();
    const approved = await upload(m.userId);
    await system(() => service.approveDocument(approved.id, reviewerId));
    await expect(upload(m.userId)).rejects.toMatchObject({ code: 'ALREADY_APPROVED' });
    expect(await read(approved.id)).toMatchObject({ state: 'COMMITTED', status: 'APPROVED' });

    const other = await mover();
    const rejected = await upload(other.userId);
    await system(() => service.rejectDocument(rejected.id, reviewerId, 'Photo is unreadable', 'UNREADABLE'));
    const again = await upload(other.userId);
    expect(again).toMatchObject({ status: 'PENDING' });
    expect(await read(rejected.id)).toMatchObject({ state: 'REJECTED', status: 'REJECTED' });
  });
});
