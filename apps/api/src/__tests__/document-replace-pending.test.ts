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
let secondReviewerId: string;
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
const openCasesFull = (id: string) => app.prisma.reviewCase.findMany({ where: { submissionId: id, closedAt: null }, select: { queue: true, priority: true } });

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
  const second = await system(() => app.prisma.user.create({ data: {
    phone: `+${phoneBase + 899_998}`, firstName: 'Synthetic', lastName: 'Second', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  users.push(second.id); secondReviewerId = second.id;
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    await app.prisma.fraudCase.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    const ids = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: ids } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

async function partner() {
  return system(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      countryCode: 'GY', isPhoneVerified: true,
    } });
    users.push(user.id);
    const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
    await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: 'Synthetic Store', slug: `syn-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 700_000 + users.length}`, addressLine1: '1 Synthetic Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
    } });
    return { userId: user.id };
  });
}

// [Opus 12 Oct · DOC-1 §24.2] A copy a reviewer escalated to a second review (or that intake routed there
// because its file matched another account) is suspicion awaiting a DIFFERENT reviewer. A new upload must not
// wipe it: the replacement is refused, the escalated copy keeps its SECOND_REVIEW case, and the second
// reviewer's confirmation still opens the fraud case.
describe('a copy under a second review is never replaced', () => {
  it.each([
    ['a mover', 'MOVER', 'national_id'],
    ['a business owner', 'RESTAURANT', 'owner_national_id'],
  ] as const)('%s: the escalated copy stays, the new upload is refused, and the second reviewer can still confirm', async (_who, role, docType) => {
    const applicant = role === 'MOVER' ? await mover() : await partner();
    const upload1 = async () => system(async () => service.submitDocument(applicant.userId, role, docType, await ownedVerificationFixture(app.prisma, applicant.userId), 'test-v1'));
    const first = await upload1();
    // Reviewer A raises the suspicion: the case moves to SECOND_REVIEW and the document stays pending.
    await system(() => service.rejectDocument(first.id, reviewerId, 'The photo looks edited', 'SUSPECTED_TAMPERING'));
    expect((await openCasesFull(first.id)).map((c) => c.queue)).toEqual(['SECOND_REVIEW']);
    // The applicant sends another copy: refused, and nothing about the escalated copy changes.
    await expect(upload1()).rejects.toMatchObject({ code: 'DOCUMENT_STILL_IN_REVIEW', message: 'This document is still being checked. You can send a new copy once that check finishes.' });
    expect(await read(first.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING' });
    expect((await openCasesFull(first.id)).map((c) => c.queue)).toEqual(['SECOND_REVIEW']);
    expect(await app.prisma.verificationDocument.count({ where: { userId: applicant.userId, docType } })).toBe(1);
    // Reviewer B confirms: the rejection, the fraud case and the legal hold land.
    expect(await system(() => service.rejectDocument(first.id, secondReviewerId, 'Confirmed edited photo', 'SUSPECTED_TAMPERING'))).toMatchObject({ status: 'REJECTED' });
    const confirmed = await read(first.id);
    expect(confirmed.legalHoldId).not.toBeNull();
    expect(await system(() => app.prisma.fraudCase.findFirst({ where: { subjectUserId: applicant.userId, submissionId: first.id } })))
      .toMatchObject({ confirmedBy: secondReviewerId, legalHoldId: confirmed.legalHoldId });
  });
});

describe('replace a document while it waits for review', () => {
  // [Opus 13 Oct · #1620 S3-1] ESCALATED is the review-SLA watchdog marking a copy overdue (more than 24 hours
  // waiting), not suspicion. A copy that waited too long is still replaceable.
  it('an overdue copy (its case moved to ESCALATED by the review-SLA watchdog) is still replaced', async () => {
    const m = await mover();
    const first = await upload(m.userId);
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: first.id, closedAt: null }, data: { slaDueAt: new Date(Date.now() - 3_600_000) } }));
    await system(() => service.alertReviewSlaBreaches());
    expect((await openCasesFull(first.id)).map((c) => c.queue)).toEqual(['ESCALATED']);
    const second = await upload(m.userId);
    expect(second).toMatchObject({ status: 'PENDING', state: 'REVIEW_QUEUED' });
    expect(await read(first.id)).toMatchObject({ state: 'SUPERSEDED', status: 'EXPIRED' });
    expect(await openCases(first.id)).toHaveLength(0);
    expect(await openCases(second.id)).toHaveLength(1);
  });

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
