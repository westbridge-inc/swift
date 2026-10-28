/**
 * [SEC-PII · money/trust scan 28 Oct 2026 · COORD ruling] AN OPEN INVESTIGATION HOLDS THE PERSON'S DOCUMENTS.
 *
 * A document whose fraud suspicion waits on a second reviewer had no hold yet (the hold is placed when the
 * second reviewer confirms), so the person's own erasure, the retention reaper or account deletion could destroy
 * it before anyone decided. Now the system places a real safety hold (the legal-hold machinery, placed by the
 * system, reason INVESTIGATION_OPEN, review date 90 days) on THAT person's documents when an investigation opens:
 * a second review, or an identity review of their identity group. Every erasure path already respects a hold.
 * The hold ends with the person's last open investigation (the deciding review, or the daily sweep) or at its
 * review date: the system never renews it; a person renews it by placing a hold of their own, which takes the
 * documents over. An account merely linked to a subject is never held.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { placeDocLegalHold } from '../modules/verification/legal-hold';
import { holdIdentityReviewMembers, INVESTIGATION_HOLD_PLACER, sweepInvestigationHolds } from '../modules/verification/investigation-hold';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stageIdentityReviewCases } from '../modules/integrity/identity-review';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { testPhone } from './helpers/fixture-ids';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const DAY = 86_400_000;
const TYPE = 'gra_restaurant_licence';
const OTHER_TYPE = 'business_registration';
const KEK = crypto.randomBytes(32).toString('base64');
const prevKek = process.env['MASTER_KEK'];

let app: FastifyInstance;
let service: VerificationService;
const tokens = new Map<string, string>();
const users: string[] = [];
const clusters: string[] = [];
let reviewerA = '';
let reviewerB = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'erasure-open-investigation-test');

class ManualKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'manual', version: 'test', external: false };
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

async function person(roles: string[] = ['VENDOR_OWNER']) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Open', lastName: `Review${RUN}`, activeRole: roles[0] as never, roles: roles as never, countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${users.length}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  await signupSelfieFixture(app.prisma, u.id);
  const token = app.jwt.sign({ userId: u.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `eoi-${RUN}-${users.length}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  tokens.set(u.id, token);
  return u.id;
}
const submit = (userId: string, docType = TYPE) => runWithTenant('swift-default', async () => service.submitDocument(userId, 'RESTAURANT', docType, await ownedVerificationFixture(app.prisma, userId), 'v1'));
const erase = (userId: string, documentIds?: string[]) => app.inject({ method: 'POST', url: '/api/v1/verification/dsar/documents/erase', payload: documentIds ? { documentIds } : {}, headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' } });
const docRow = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, include: { legalHold: true } }));
const outcomeOf = (res: { json: () => { data: Array<{ documentId: string; outcome: string; ground?: string }> } }, docId: string) => res.json().data.find((o) => o.documentId === docId)!;
/** The first reviewer's fraud-class verdict: suspicion, the case goes to SECOND_REVIEW (the document stays pending). */
const suspect = (docId: string) => runWithTenant('swift-default', () => service.rejectDocument(docId, reviewerA, `Looks altered ${RUN}`, 'SUSPECTED_TAMPERING'));
const systemHoldOf = (userId: string) => system(() => app.prisma.docLegalHold.findFirst({ where: { subjectUserId: userId, placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null } }));

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
  reviewerA = await person(['SUPER_ADMIN', 'CUSTOMER']);
  reviewerB = await person(['SUPER_ADMIN', 'CUSTOMER']);
});

afterAll(async () => {
  await system(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: users } }, { entity: 'DocLegalHold' }] }, 'test-cleanup:erasure-open-investigation').catch(() => 0);
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.fraudCase.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: users } } }).catch(() => 0);
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    // identity review history is append-only in the database: test cleanup only, with triggers off for this transaction
    await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.identityReviewCase.deleteMany({ where: { clusterId: { in: clusters } } });
      await tx.identityClusterMember.deleteMany({ where: { clusterId: { in: clusters } } });
      await tx.identityCluster.deleteMany({ where: { id: { in: clusters } } });
    });
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

describe('[SEC-PII] an open investigation holds the person\'s documents', () => {
  it('a second review places the system hold: the person\'s erasure refuses it (legal hold), the reaper and the abandoned sweep keep it', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    const other = (await submit(me, OTHER_TYPE)).id;
    await suspect(doc);
    const held = await docRow(doc);
    expect(held.legalHold).toMatchObject({ placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null });
    expect(held.legalHold!.reason).toBe(`INVESTIGATION_OPEN second-review:${doc}`);
    // the review date: 90 days, never more
    expect(Math.round((held.legalHold!.reviewBy.getTime() - Date.now()) / DAY)).toBe(90);
    // the suspected document only (the evidence): the person's other document is not held by it
    expect((await docRow(other)).legalHoldId).toBeNull();
    const res = await erase(me);
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res, doc)).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
    expect((await docRow(doc)).purgedAt).toBeNull();
    // [Privacy §6] told why and when, in writing: on the answer and in the inbox; generic words, the hold's review date
    const day = held.legalHold!.reviewBy.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'long', year: 'numeric' });
    const told = outcomeOf(res, doc) as unknown as { message: string; revisitBy: string };
    expect(told.message).toContain('part of a review that is still open');
    expect(told.message).toContain(day);
    expect(new Date(told.revisitBy).getTime()).toBe(held.legalHold!.reviewBy.getTime());
    const inbox = await system(() => app.prisma.notification.findMany({ where: { userId: me, title: 'Your deletion request is delayed' } }));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toContain(day);
    for (const secret of ['fraud', 'Fraud', 'TAMPERING', 'second review', 'suspect']) expect(JSON.stringify([told, inbox[0]]), secret).not.toContain(secret);
    // the retention reaper: even with its clock run out
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc }, data: { retentionExpiresAt: new Date(Date.now() - DAY) } }));
    await system(() => service.purgeExpiredDocuments());
    expect((await docRow(doc)).purgedAt).toBeNull();
    // the abandoned-application sweep, long after the last activity
    await system(() => service.sweepAbandonedApplications(new Date(Date.now() + 200 * DAY)));
    expect((await docRow(doc)).purgedAt).toBeNull();
    // the daily sweep keeps the hold while the review is open and its date not reached
    await system(() => sweepInvestigationHolds(app.prisma));
    expect((await systemHoldOf(me))?.id).toBe(held.legalHoldId);
  });

  it('the second reviewer\'s decision that ends the review releases the hold (audited); erasure then works', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    const holdId = (await systemHoldOf(me))!.id;
    // a different reviewer decides it is not fraud: an ordinary rejection closes the second review
    await runWithTenant('swift-default', () => service.rejectDocument(doc, reviewerB, `Photo too dark ${RUN}`, 'UNREADABLE'));
    expect(await systemHoldOf(me)).toBeNull();
    const released = await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: holdId } }));
    expect(released).toMatchObject({ releasedBy: INVESTIGATION_HOLD_PLACER, releaseReason: 'investigation closed' });
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'RELEASE_INVESTIGATION_HOLD', entityId: holdId } }))).toBe(1);
    expect(outcomeOf(await erase(me, [doc]), doc).outcome).toBe('DESTROYED');
  });

  it('a confirmed fraud: the fraud hold takes the documents over (subject only); a linked account that is not the subject stays erasable', async () => {
    const subject = await person();
    const linked = await person();
    const clusterId = `cl-${nanoid(8)}`; clusters.push(clusterId);
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: clusterId } });
      for (const accountId of [subject, linked]) await app.prisma.identityClusterMember.create({ data: { accountId, clusterId, linkedVia: [] } });
    });
    const doc = (await submit(subject)).id;
    const linkedDoc = (await submit(linked)).id;
    await suspect(doc);
    expect((await docRow(linkedDoc)).legalHoldId).toBeNull();
    await runWithTenant('swift-default', () => service.rejectDocument(doc, reviewerB, `Same licence as another account ${RUN}`, 'SUSPECTED_TAMPERING'));
    const after = await docRow(doc);
    expect(after.legalHold).toMatchObject({ placedBy: reviewerB, releasedAt: null });
    expect(await systemHoldOf(subject)).toBeNull();
    // the linked account is not held: its own erasure works
    expect(outcomeOf(await erase(linked, [linkedDoc]), linkedDoc).outcome).toBe('DESTROYED');
  });

  it('the hold expires at its review date when no person renewed it; a person renews it by placing their own hold', async () => {
    const lapsed = await person();
    const lapsedDoc = (await submit(lapsed)).id;
    await suspect(lapsedDoc);
    const renewed = await person();
    const renewedDoc = (await submit(renewed)).id;
    await suspect(renewedDoc);
    // a person renews one of them: their hold takes the documents over (the empty system hold ends on its own terms)
    await system(() => placeDocLegalHold(app.prisma, { subjectUserId: renewed, reason: `Renewed after the review stalled ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 200 * DAY) }));
    expect((await docRow(renewedDoc)).legalHold).toMatchObject({ placedBy: reviewerB });
    // the daily sweep, 91 days on: the system hold has lapsed (the review is still open)
    const at = new Date(Date.now() + 91 * DAY);
    const swept = await system(() => sweepInvestigationHolds(app.prisma, at));
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(await systemHoldOf(lapsed)).toBeNull();
    expect((await docRow(lapsedDoc)).legalHoldId).toBeNull();
    expect((await docRow(renewedDoc)).legalHold).toMatchObject({ placedBy: reviewerB, releasedAt: null });
  });

  it('the daily sweep releases the hold of an investigation that ended any other way', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: doc, closedAt: null }, data: { closedAt: new Date() } }));
    await system(() => sweepInvestigationHolds(app.prisma));
    expect(await systemHoldOf(me)).toBeNull();
  });

  it('a new identity review holds each member\'s documents', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    const clusterId = `cl-${nanoid(8)}`; clusters.push(clusterId);
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: clusterId, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: me, clusterId, linkedVia: [] } });
    });
    // the staging job walks every flagged group in order; run it until ours has its case, holding each page's members
    let cursor: string | undefined;
    for (let i = 0; i < 40; i++) {
      const page = await system(() => stageIdentityReviewCases(app.prisma, cursor));
      await system(() => holdIdentityReviewMembers(app.prisma, page.cases.filter((c) => c.clusterId === clusterId)));
      if (page.cases.some((c) => c.clusterId === clusterId) || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect((await docRow(doc)).legalHold).toMatchObject({ placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null, reason: `INVESTIGATION_OPEN identity-review:${clusterId}` });
  });

  it('when a second review closes while the identity review stays open, its documents move to the identity review\'s hold', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc); // the second review's hold stamps the document first
    const clusterId = `cl-${nanoid(8)}`; clusters.push(clusterId);
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: clusterId, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: me, clusterId, linkedVia: [] } });
    });
    const review = await system(() => app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: me }] }, complete: true } }));
    await system(() => holdIdentityReviewMembers(app.prisma, [review]));
    const secondReviewHold = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: me, reason: `INVESTIGATION_OPEN second-review:${doc}`, releasedAt: null } }));
    // (While the identity record awaits review, no person may decide this document: recusal cannot be resolved.)
    // The second review ends another way (the case is closed); the daily sweep releases ITS hold, on the system's own
    // path: the pending identity review (which refuses every human release) does not keep it open.
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: doc, closedAt: null }, data: { closedAt: new Date() } }));
    expect((await system(() => sweepInvestigationHolds(app.prisma))).closed).toBeGreaterThanOrEqual(1);
    expect((await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: secondReviewHold.id } }))).releaseReason).toBe('investigation closed');
    // ... and the identity review's hold keeps the document
    expect((await docRow(doc)).legalHold).toMatchObject({ reason: `INVESTIGATION_OPEN identity-review:${clusterId}`, releasedAt: null });
    expect((await docRow(doc)).purgedAt).toBeNull();
  });

  it('the system release path is the system\'s alone: no route reaches it, and it never releases a person\'s hold', () => {
    const src = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); } else if (p.endsWith('.ts')) files.push(p); } };
    walk(src);
    const callers = files.filter((f) => /releaseClosedInvestigationHolds|sweepInvestigationHolds/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f)).sort();
    expect(callers).toEqual(['jobs/queue.ts', 'modules/verification/investigation-hold.ts', 'modules/verification/verification.service.ts']);
    const ih = readFileSync(join(src, 'modules/verification/investigation-hold.ts'), 'utf8');
    expect(ih).toContain("where: { id: hold.id, placedBy: INVESTIGATION_HOLD_PLACER, reason: { startsWith: `${INVESTIGATION_HOLD_REASON} ` }, releasedAt: null }");
  });

  it('account deletion keeps a document under the hold, says why and when; when the review ends the retry erases it', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    const reviewBy = (await systemHoldOf(me))!.reviewBy;
    const accounts = new AccountService({ prisma: app.prisma, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as never } as never);
    const result = await accounts.deleteAccount(me) as { message: string };
    expect(result).toMatchObject({ deleted: false, status: 'PENDING_LEGAL_HOLD' });
    expect(result.message).toContain('part of a review that is still open');
    expect(result.message).toContain(reviewBy.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'long', year: 'numeric' }));
    expect(result.message).not.toMatch(/fraud|tamper/i);
    expect((await docRow(doc)).purgedAt).toBeNull();
    // the review ends (any way): the sweep releases the hold, and the existing retry (the reaper on the deferred clock) erases it
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: doc, closedAt: null }, data: { closedAt: new Date() } }));
    await system(() => sweepInvestigationHolds(app.prisma));
    await system(() => service.purgeExpiredDocuments());
    expect((await docRow(doc)).purgedAt).not.toBeNull();
  });

  it('precedence: a person\'s hold always wins; the system hold never overwrites it, and its release never clears it', async () => {
    const me = await person();
    const kept = (await submit(me)).id;
    const other = (await submit(me, OTHER_TYPE)).id;
    const human = await system(() => placeDocLegalHold(app.prisma, { subjectUserId: me, documentIds: [kept], reason: `Court order ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 30 * DAY) }));
    await suspect(kept);
    // the system hold never overwrites the person's hold on the suspected document
    expect((await docRow(kept)).legalHoldId).toBe(human.hold.id);
    expect(await systemHoldOf(me)).not.toBeNull();
    expect((await docRow(other)).legalHoldId).toBeNull();
    // the investigation closes: only documents still stamped with the system hold are unstamped
    await runWithTenant('swift-default', () => service.rejectDocument(kept, reviewerB, `Photo too dark ${RUN}`, 'UNREADABLE'));
    expect(await systemHoldOf(me)).toBeNull();
    expect((await docRow(kept)).legalHoldId).toBe(human.hold.id);
    expect((await docRow(other)).legalHoldId).toBeNull();
    // ... and the expiry sweep never touches a person's hold either
    await system(() => sweepInvestigationHolds(app.prisma, new Date(Date.now() + 400 * DAY)));
    expect((await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: human.hold.id } }))).releasedAt).toBeNull();
  });
});
