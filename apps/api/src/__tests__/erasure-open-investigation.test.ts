/**
 * [SEC-PII · money/trust scan 28 Oct 2026] A DOCUMENT UNDER AN OPEN REVIEW WAITS FOR THE REVIEW.
 *
 * A person's own erasure refused only a legal hold, an AML record or an approved licence backing a live
 * relationship. A document waiting on a second reviewer (a fraud-class suspicion) has no hold yet, so it could
 * be destroyed before that review decided anything. Erasure now refuses a document under an open investigation
 * (an open SECOND_REVIEW case on it, an open fraud case on or linking the person, an open identity review of the
 * person's identity group) with its own ground, OPEN_INVESTIGATION, and plain words; the check is made again
 * under the person's row lock; account deletion keeps such a document too. When the review ends, erasure works.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { AccountService } from '../modules/user/account.service';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { purgeAuditLogs } from '../lib/audit-immutability';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { testPhone } from './helpers/fixture-ids';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const DAY = 86_400_000;
const TYPE = 'gra_restaurant_licence';
const KEK = crypto.randomBytes(32).toString('base64');
const prevKek = process.env['MASTER_KEK'];
const WORDS = 'This document is part of a review that is still open. It is kept until the review ends, and your request is completed then.';

let app: FastifyInstance;
let service: VerificationService;
const tokens = new Map<string, string>();
const users: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'erasure-open-investigation-test');

class ManualKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'manual', version: 'test', external: false };
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

async function person() {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Open', lastName: `Review${RUN}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${users.length}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  await signupSelfieFixture(app.prisma, u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `eoi-${RUN}-${users.length}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  tokens.set(u.id, token);
  return u.id;
}
const submit = (userId: string, docType = TYPE) => runWithTenant('swift-default', async () => service.submitDocument(userId, 'RESTAURANT', docType, await ownedVerificationFixture(app.prisma, userId), 'v1'));
const erase = (userId: string, documentIds?: string[]) => app.inject({ method: 'POST', url: '/api/v1/verification/dsar/documents/erase', payload: documentIds ? { documentIds } : {}, headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' } });
const docRow = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }));
const openCase = (docId: string) => system(() => app.prisma.reviewCase.findFirstOrThrow({ where: { submissionId: docId, closedAt: null } }));
/** The first reviewer's fraud-class suspicion moved the case to the second-review queue (the document stays pending, no hold yet). */
const toSecondReview = async (docId: string) => { const c = await openCase(docId); await system(() => app.prisma.reviewCase.update({ where: { id: c.id }, data: { queue: 'SECOND_REVIEW' } })); return c.id; };
const closeCase = (caseId: string) => system(() => app.prisma.reviewCase.update({ where: { id: caseId }, data: { closedAt: new Date() } }));
const outcomeOf = (res: { json: () => { data: Array<{ documentId: string; outcome: string; ground?: string; message?: string }> } }, docId: string) => res.json().data.find((o) => o.documentId === docId)!;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = KEK;
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualKyc());
});

afterAll(async () => {
  await system(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
    await purgeAuditLogs(app.prisma, { userId: { in: users } }, 'test-cleanup:erasure-open-investigation').catch(() => 0);
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek;
  resetKeyProviderForTests();
  await app.close();
});

describe('[SEC-PII] erasure waits for an open review', () => {
  it('a document waiting on a second review is refused with OPEN_INVESTIGATION and plain words; nothing is destroyed; after the review it is erased', async () => {
    const me = await person();
    const suspect = (await submit(me)).id;
    const plain = (await submit(me, 'business_registration')).id; // another type: a second copy of the same type would replace the first
    const caseId = await toSecondReview(suspect);
    const res = await erase(me);
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res, suspect)).toMatchObject({ outcome: 'REFUSED', ground: 'OPEN_INVESTIGATION', message: WORDS });
    expect((await docRow(suspect)).purgedAt).toBeNull();
    expect((await docRow(suspect)).fileUrl).not.toBe('');
    // the person's other document is erased as before
    expect(outcomeOf(res, plain).outcome).toBe('DESTROYED');
    // the review ends: erasure works
    await closeCase(caseId);
    const again = await erase(me, [suspect]);
    expect(outcomeOf(again, suspect).outcome).toBe('DESTROYED');
  });

  it('an open fraud case on the person, or linking them, keeps every document; a released hold ends it', async () => {
    const subject = await person();
    const linked = await person();
    const subjectDoc = (await submit(subject)).id;
    const linkedDoc = (await submit(linked)).id;
    const fraud = await system(() => app.prisma.fraudCase.create({ data: {
      subjectUserId: subject, submissionId: subjectDoc, caseId: randomUUID(), reasonCode: 'SYNTHETIC', confirmedBy: 'test', linkedAccountIds: [linked],
    } }));
    cleanups.push(() => app.prisma.fraudCase.deleteMany({ where: { id: fraud.id } }));
    for (const [who, doc] of [[subject, subjectDoc], [linked, linkedDoc]] as const) {
      const res = await erase(who);
      expect(outcomeOf(res, doc), who).toMatchObject({ outcome: 'REFUSED', ground: 'OPEN_INVESTIGATION' });
      expect((await docRow(doc)).purgedAt).toBeNull();
    }
    // the founder's decision released the case's hold: erasure works
    const hold = await system(() => app.prisma.docLegalHold.create({ data: { subjectUserId: subject, reason: 'fraud', ownerId: 'test', placedBy: 'test', reviewBy: new Date(Date.now() + 30 * DAY), releasedAt: new Date(), releasedBy: 'test' } }));
    cleanups.push(() => app.prisma.docLegalHold.deleteMany({ where: { id: hold.id } }));
    await system(() => app.prisma.fraudCase.update({ where: { id: fraud.id }, data: { legalHoldId: hold.id } }));
    expect(outcomeOf(await erase(linked), linkedDoc).outcome).toBe('DESTROYED');
  });

  it('an open identity review of the person\'s identity group keeps their documents', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    const clusterId = `cl-${nanoid(8)}`;
    await system(async () => {
      // an identity review is opened only on a group flagged for review (the database's own lineage rule)
      await app.prisma.identityCluster.create({ data: { id: clusterId, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: me, clusterId, linkedVia: [] } });
    });
    const review = await system(() => app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId, snapshotDigest: nanoid(8), snapshot: {}, complete: true } }));
    cleanups.push(async () => { await app.prisma.identityReviewCase.deleteMany({ where: { id: review.id } }); await app.prisma.identityClusterMember.deleteMany({ where: { accountId: me } }); await app.prisma.identityCluster.deleteMany({ where: { id: clusterId } }); });
    const res = await erase(me);
    expect(outcomeOf(res, doc)).toMatchObject({ outcome: 'REFUSED', ground: 'OPEN_INVESTIGATION' });
    expect((await docRow(doc)).purgedAt).toBeNull();
  });

  it('under the person\'s row lock: a review opened after the census still keeps the document (the purge step refuses)', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await toSecondReview(doc);
    const row = await docRow(doc);
    const result = await service.purgeDocumentNow({ id: doc, userId: me, fileUrl: row.fileUrl, docType: row.docType, user: { tenantId: 'swift-default' } }, me,
      { requireRetentionElapsed: false, shredFields: true, keepUnderInvestigation: true });
    expect(result).toBe('NOT_PURGED');
    expect((await docRow(doc)).purgedAt).toBeNull();
    expect((await system(() => app.prisma.encryptedObject.findUnique({ where: { fileKey: row.fileUrl } })))?.shreddedAt ?? null).toBeNull();
  });

  it('account deletion keeps a document under an open review (and says so); the rest of the account is erased', async () => {
    const me = await person();
    const suspect = (await submit(me)).id;
    await toSecondReview(suspect);
    const accounts = new AccountService({ prisma: app.prisma, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as never } as never);
    const result = await accounts.deleteAccount(me) as Record<string, unknown>;
    expect(result).toMatchObject({ deleted: false, status: 'PENDING_LEGAL_HOLD', heldForReview: 1 });
    expect(String(result['message'])).toContain('part of a review that is still open');
    expect((await docRow(suspect)).purgedAt).toBeNull();
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: me } }))).phone).toBe(`deleted:${me}`);
  });
});
