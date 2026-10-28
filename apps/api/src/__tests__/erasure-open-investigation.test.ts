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
import { placeDocLegalHold, releaseDocLegalHold } from '../modules/verification/legal-hold';
import * as investigationHold from '../modules/verification/investigation-hold';
import { accountClosedKeptWords, erasureCompletedWords, holdIdentityReviewMembers, INVESTIGATION_HOLD_PLACER, releaseClosedInvestigationHolds, sweepInvestigationHolds } from '../modules/verification/investigation-hold';
import { vi } from 'vitest';
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
    expect(told.message).toContain('One of your documents is part of a review that is still open, so we cannot delete it yet.');
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

  it('[COORD renewal ruling] still open at its date: the SAME hold is renewed (+90 d, audited), the person told the new date; at 180 days a person is asked to decide', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    const hold = (await systemHoldOf(me))!;
    const notified: Array<{ userId: string; revisitBy: Date }> = [];
    const escalated: string[] = [];
    const deps = {
      notifyPerson: async (userId: string, revisitBy: Date, holdId: string) => { notified.push({ userId, revisitBy }); await service.notifyRenewalIfDelayed(userId, revisitBy, holdId); },
      escalate: async (h: { id: string }) => { escalated.push(h.id); },
    };
    const at91 = new Date(Date.now() + 91 * DAY);
    const first = await system(() => sweepInvestigationHolds(app.prisma, at91, undefined, deps));
    expect(first.renewed).toBeGreaterThanOrEqual(1);
    const renewed = await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: hold.id } }));
    expect(renewed.releasedAt).toBeNull(); // the same hold, never release-then-replace
    expect(Math.round((renewed.reviewBy.getTime() - at91.getTime()) / DAY)).toBe(90);
    expect((await docRow(doc)).legalHoldId).toBe(hold.id);
    const audit = await system(() => app.prisma.auditLog.findMany({ where: { entityId: hold.id, action: 'RENEW_INVESTIGATION_HOLD' } }));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.changes as { reason: string }).reason).toBe('investigation still open, renewed by system');
    expect(await system(() => app.prisma.docLegalHold.count({ where: { subjectUserId: me, placedBy: INVESTIGATION_HOLD_PLACER } }))).toBe(1);
    expect(notified.filter((n) => n.userId === me).map((n) => n.revisitBy.getTime())).toEqual([renewed.reviewBy.getTime()]);
    // [REVIEW-F S3-1 · REVIEW-G S3-2 · COORD] this person never asked to delete anything: no notice, no tip-off
    expect(await system(() => app.prisma.notification.count({ where: { userId: me, title: 'Your deletion request is delayed' } }))).toBe(0);
    expect(escalated).not.toContain(hold.id);
    // past 180 days in all (and due again): renewed once more, and handed to a person, once
    const at182 = new Date(renewed.reviewBy.getTime() + DAY);
    await system(() => sweepInvestigationHolds(app.prisma, at182, undefined, deps));
    expect(escalated.filter((id) => id === hold.id)).toHaveLength(1);
    expect(await system(() => app.prisma.auditLog.count({ where: { entityId: hold.id, action: 'ESCALATE_INVESTIGATION_HOLD' } }))).toBe(1);
    expect((await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: hold.id } }))).releasedAt).toBeNull();
  });

  it('a person renews by placing their own hold; a person who RELEASES the system hold has decided: the system never places it again', async () => {
    const renewedBy = await person();
    const renewedDoc = (await submit(renewedBy)).id;
    await suspect(renewedDoc);
    await system(() => placeDocLegalHold(app.prisma, { subjectUserId: renewedBy, reason: `Renewed after the review stalled ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 200 * DAY) }));
    expect((await docRow(renewedDoc)).legalHold).toMatchObject({ placedBy: reviewerB });
    // an identity review member whose system hold a person released
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const member = await person();
    const memberDoc = (await submit(member)).id;
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: member, clusterId: root, linkedVia: [] } });
      await app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: {}, complete: true } });
    });
    await system(() => sweepInvestigationHolds(app.prisma));
    const sys = (await systemHoldOf(member))!;
    await system(() => app.prisma.docLegalHold.update({ where: { id: sys.id }, data: { releasedAt: new Date(), releasedBy: reviewerB, releaseReason: `Decided: not needed ${RUN}` } }));
    await system(() => app.prisma.verificationDocument.updateMany({ where: { legalHoldId: sys.id }, data: { legalHoldId: null } }));
    await system(() => sweepInvestigationHolds(app.prisma));
    expect(await systemHoldOf(member)).toBeNull();
    expect((await docRow(memberDoc)).legalHoldId).toBeNull();
    // ... and the lock-time backstop honours that decision too: the person's erasure works
    expect(outcomeOf(await erase(member, [memberDoc]), memberDoc).outcome).toBe('DESTROYED');
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
    // [REVIEW-F S3-2 · COORD] a two-line toast: the date first, about 80 characters, singular for one, no jargon
    // [REVIEW-F · COORD 16:02Z] a short month (Jan..Dec, never 'Sept') so it fits at large font sizes
    const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(reviewBy);
    const pick = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const day = `${pick('day')} ${SHORT[pick('month') - 1]} ${pick('year')}`;
    expect(result.message).toBe(`Account closed. Until at least ${day}, 1 document is kept for a check, then deleted.`);
    expect(result.message.length).toBeLessThanOrEqual(90);
    // the worst case (two-digit day and count): the date is read first; the line is COORD's own example length
    const worst = accountClosedKeptWords(new Date('2027-09-30T15:00:00Z'), 12);
    expect(worst).toBe('Account closed. Until at least 30 Sep 2027, 12 documents are kept for a check, then deleted.');
    // [REVIEW-F #2190 S3-1] the date ends by character 45 in the worst case (1.3x text: ~60-68 characters on two lines)
    expect(worst.indexOf('30 Sep 2027') + '30 Sep 2027'.length).toBeLessThanOrEqual(45);
    expect(worst.length).toBeLessThanOrEqual(92);
    // the day is Guyana's: 02:00 UTC on 1 October is still 30 September in Georgetown
    expect(accountClosedKeptWords(new Date('2027-10-01T02:00:00Z'), 1)).toContain('Until at least 30 Sep 2027,');
    expect(result.message).not.toMatch(/fraud|tamper|legal hold/i);
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

  it('[review gap 1] a person releasing their own hold never frees a document an open investigation of the subject still needs', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    const human = await system(() => placeDocLegalHold(app.prisma, { subjectUserId: me, documentIds: [doc], reason: `Court order ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 30 * DAY) }));
    await suspect(doc); // the second review opens; the person's hold keeps the document, the system hold waits empty
    const systemHold = (await systemHoldOf(me))!;
    expect((await docRow(doc)).legalHoldId).toBe(human.hold.id);
    await system(() => releaseDocLegalHold(app.prisma, { holdId: human.hold.id, releasedBy: reviewerB, reason: `Court order lifted ${RUN}` }));
    expect((await docRow(doc)).legalHoldId).toBe(systemHold.id);
    expect(outcomeOf(await erase(me, [doc]), doc)).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
  });

  it('[review gap 2] an identity review opened by any path holds EVERY member of the live group chain (the daily sweep: refresh and backfill)', async () => {
    const root = `cl-${nanoid(8)}`; const child = `cl-${nanoid(8)}`; clusters.push(child, root);
    const inSnapshot = await person();
    const joinedLater = await person();
    const mergedIn = await person();
    const docs = { inSnapshot: (await submit(inSnapshot)).id, joinedLater: (await submit(joinedLater)).id, mergedIn: (await submit(mergedIn)).id };
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: inSnapshot, clusterId: root, linkedVia: [] } });
    });
    // opened directly (not through the scan route), with a snapshot that names one member only
    await system(() => app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: inSnapshot }] }, complete: true } }));
    // since then: a member joined the group, and another group (with its member) was merged into it
    await system(async () => {
      await app.prisma.identityClusterMember.create({ data: { accountId: joinedLater, clusterId: root, linkedVia: [] } });
      await app.prisma.identityCluster.create({ data: { id: child, mergedIntoId: root } });
      await app.prisma.identityClusterMember.create({ data: { accountId: mergedIn, clusterId: child, linkedVia: [] } });
    });
    await system(() => sweepInvestigationHolds(app.prisma));
    for (const [who, doc] of Object.entries(docs)) {
      expect((await docRow(doc)).legalHold, who).toMatchObject({ placedBy: INVESTIGATION_HOLD_PLACER, reason: `INVESTIGATION_OPEN identity-review:${root}`, releasedAt: null });
    }
  });

  it('[review gap 2] backstop: a member who joined after the last sweep is still kept by erasure, under the lock', async () => {
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const anchor = await person();
    const newcomer = await person();
    const doc = (await submit(newcomer)).id;
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: anchor, clusterId: root, linkedVia: [] } });
      await app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: anchor }] }, complete: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: newcomer, clusterId: root, linkedVia: [] } });
    });
    expect((await docRow(doc)).legalHoldId).toBeNull(); // no sweep yet
    expect(outcomeOf(await erase(newcomer, [doc]), doc).outcome).toBe('REFUSED');
    expect((await docRow(doc)).purgedAt).toBeNull();
    // nor the retention reaper, with its clock run out
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc }, data: { retentionExpiresAt: new Date(Date.now() - DAY) } }));
    await system(() => service.purgeExpiredDocuments());
    expect((await docRow(doc)).purgedAt).toBeNull();
  });

  it('[review gap 3] the sweep examines every system hold, page by page, never only the oldest few', async () => {
    const people = [await person(), await person(), await person()];
    for (const p of people) {
      const doc = (await submit(p)).id;
      await suspect(doc);
      await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: doc, closedAt: null }, data: { closedAt: new Date() } }));
    }
    const swept = await system(() => sweepInvestigationHolds(app.prisma, new Date(), 1));
    expect(swept.examined).toBeGreaterThanOrEqual(3);
    for (const p of people) expect(await systemHoldOf(p)).toBeNull();
  });

  it('[REVIEW-M S3-1 probe P1] a document submitted after the identity-review hold exists is stamped onto it; its erasure is told why and when', async () => {
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const me = await person();
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: me, clusterId: root, linkedVia: [] } });
    });
    const review = await system(() => app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: me }] }, complete: true } }));
    await system(() => holdIdentityReviewMembers(app.prisma, [review])); // no documents yet: an empty hold
    const doc = (await submit(me)).id;
    await system(() => sweepInvestigationHolds(app.prisma)); // the daily refresh
    const row = await docRow(doc);
    expect(row.legalHold).toMatchObject({ reason: `INVESTIGATION_OPEN identity-review:${root}`, releasedAt: null });
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'REFRESH_INVESTIGATION_HOLD', entityId: row.legalHoldId! } }))).toBe(1);
    const res = await erase(me, [doc]);
    const o = outcomeOf(res, doc) as unknown as { outcome: string; ground: string; revisitBy?: string };
    expect(o).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
    expect(o.revisitBy).toBeTruthy();
    expect(await system(() => app.prisma.notification.count({ where: { userId: me, title: 'Your deletion request is delayed' } }))).toBe(1);
  });

  it('[REVIEW-G S3-3] a newcomer the sweep has not reached: the erasure places the review\'s hold first, so the refusal is a real hold with why and when', async () => {
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const anchor = await person();
    const newcomer = await person();
    const doc = (await submit(newcomer)).id;
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: anchor, clusterId: root, linkedVia: [] } });
      await app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: {}, complete: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: newcomer, clusterId: root, linkedVia: [] } });
    });
    const o = outcomeOf(await erase(newcomer, [doc]), doc) as unknown as { outcome: string; ground: string; revisitBy?: string; message?: string };
    expect(o).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
    expect(o.revisitBy).toBeTruthy();
    expect(o.message).toContain('part of a review that is still open');
    expect((await docRow(doc)).legalHold).toMatchObject({ placedBy: INVESTIGATION_HOLD_PLACER, reason: `INVESTIGATION_OPEN identity-review:${root}` });
  });

  it('[REVIEW-G S3-1] the promise is kept: when the review ends, the document the person asked to erase is erased (bytes and values)', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    expect(outcomeOf(await erase(me, [doc]), doc)).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
    // the deciding review ends the investigation: the delayed erasure runs as the person asked
    await runWithTenant('swift-default', () => service.rejectDocument(doc, reviewerB, `Photo too dark ${RUN}`, 'UNREADABLE'));
    expect((await docRow(doc)).purgedAt).not.toBeNull();
    expect(await system(() => app.prisma.auditLog.count({ where: { userId: me, action: 'DSAR_DOCUMENT_ERASURE' } }))).toBe(2);
    // [COORD 10:24Z] one notice to the requester once it is done
    expect((await system(() => app.prisma.notification.findMany({ where: { userId: me, title: 'Your document has been deleted' } }))).map((n) => n.body)).toEqual(['We have now deleted the document you asked us to delete.']);
    // ... and through the daily sweep when the review ends another way
    const other = await person();
    const otherDoc = (await submit(other)).id;
    await suspect(otherDoc);
    await erase(other, [otherDoc]);
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: otherDoc, closedAt: null }, data: { closedAt: new Date() } }));
    await system(() => sweepInvestigationHolds(app.prisma, new Date(), undefined, { onFreed: async (userId, ids) => { await service.completeDeferredErasures(userId, ids); } }));
    expect((await docRow(otherDoc)).purgedAt).not.toBeNull();
  });

  it('[REVIEW-G S3-4] "everything else has been deleted" only when it is true', async () => {
    const me = await person();
    const suspected = (await submit(me)).id;
    const courtHeld = (await submit(me, OTHER_TYPE)).id;
    await system(() => placeDocLegalHold(app.prisma, { subjectUserId: me, documentIds: [courtHeld], reason: `Court order ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 30 * DAY) }));
    await suspect(suspected);
    const res = await erase(me);
    const told = outcomeOf(res, suspected) as unknown as { message: string };
    expect(told.message).not.toContain('Everything else');
    expect(outcomeOf(res, courtHeld)).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
  });

  it('[REVIEW-M S4-3] a hold whose investigation closed (not yet swept) never takes documents as a successor', async () => {
    const me = await person();
    const kept = (await submit(me)).id;
    const b = (await submit(me, OTHER_TYPE)).id;
    const human = await system(() => placeDocLegalHold(app.prisma, { subjectUserId: me, documentIds: [kept], reason: `Court order ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 30 * DAY) }));
    await suspect(b);
    const holdB = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: me, reason: `INVESTIGATION_OPEN second-review:${b}`, releasedAt: null } }));
    // b's review ends unseen (no sweep yet); then the person's hold is released: the document is freed, not handed to b's closed hold
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: b, closedAt: null }, data: { closedAt: new Date() } }));
    await system(() => releaseDocLegalHold(app.prisma, { holdId: human.hold.id, releasedBy: reviewerA, reason: `Court order lifted ${RUN}` }));
    expect((await docRow(kept)).legalHoldId).toBeNull();
    expect((await docRow(kept)).legalHoldId).not.toBe(holdB.id);
  });


  it('[REVIEW-G S3-2 · probe Q1] a renewal never tells a person who asked for no deletion that their deletion request is delayed', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc); // second review opens; the person never asks to erase anything
    await system(() => sweepInvestigationHolds(app.prisma, new Date(Date.now() + 91 * DAY), undefined, {
      notifyPerson: async (userId: string, revisitBy: Date, holdId: string) => { await service.notifyRenewalIfDelayed(userId, revisitBy, holdId); },
    }));
    const inbox = await system(() => app.prisma.notification.findMany({ where: { userId: me } }));
    expect(inbox.map((n) => n.title)).not.toContain('Your deletion request is delayed');
    expect(JSON.stringify(inbox)).not.toContain('part of a review');
  });

  it('[REVIEW-G S3-3 · probe Q2] a person who releases the system hold also frees the delayed erasure the person was promised', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    const res = await erase(me, [doc]);
    expect((outcomeOf(res, doc) as unknown as { message?: string }).message).toContain('look at your request again');
    const hold = (await systemHoldOf(me))!;
    await system(() => releaseDocLegalHold(app.prisma, { holdId: hold.id, releasedBy: reviewerB, reason: `Not needed ${RUN}` }));
    expect((await docRow(doc)).legalHoldId).toBeNull();
    await system(() => sweepInvestigationHolds(app.prisma, new Date(), undefined, { retryDelayedErasures: () => service.retryDelayedErasures() }));
    expect((await docRow(doc)).purgedAt).not.toBeNull();
  });

  it('[REVIEW-G S3-1 · probe QA] a NEW identity review on a group whose earlier review hold a person released still holds the member', async () => {
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const me = await person();
    const doc = (await submit(me)).id;
    let first = '';
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: me, clusterId: root, linkedVia: [] } });
      first = (await app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: me }] }, complete: true } })).id;
    });
    await system(() => sweepInvestigationHolds(app.prisma));
    const hold = (await systemHoldOf(me))!;
    expect(hold).not.toBeNull();
    // a person decides the first review does not need the documents
    // (modelled as the PR's own test models a person's release: the strict route refuses while the identity is unresolved)
    await system(() => app.prisma.docLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedBy: reviewerB, releaseReason: `Decided: not needed ${RUN}` } }));
    await system(() => app.prisma.verificationDocument.updateMany({ where: { legalHoldId: hold.id }, data: { legalHoldId: null } }));
    // the first review ends; later a NEW review of the same group opens
    await system(() => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.identityReviewCase.update({ where: { id: first }, data: { status: 'RETAINED', reviewedAt: new Date() } });
      await tx.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: me }] }, complete: true } });
    }));
    await system(() => sweepInvestigationHolds(app.prisma));
    const res = await erase(me, [doc]);
    const row = await docRow(doc);
    expect({ outcome: outcomeOf(res, doc).outcome, purged: row.purgedAt !== null, held: row.legalHoldId !== null }).toEqual({ outcome: 'REFUSED', purged: false, held: true });
  });

  it('[REVIEW-G S3-2] a person whose erasure the review delays IS told the renewed date', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    await erase(me, [doc]);
    const before = await system(() => app.prisma.notification.count({ where: { userId: me, title: 'Your deletion request is delayed' } }));
    await system(() => sweepInvestigationHolds(app.prisma, new Date(Date.now() + 91 * DAY), undefined, {
      notifyPerson: async (userId: string, revisitBy: Date, holdId: string) => { await service.notifyRenewalIfDelayed(userId, revisitBy, holdId); },
    }));
    const hold = (await systemHoldOf(me))!;
    const day = hold.reviewBy.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'long', year: 'numeric' });
    const inbox = await system(() => app.prisma.notification.findMany({ where: { userId: me, title: 'Your deletion request is delayed' } }));
    expect(inbox.length).toBe(before + 1);
    expect(inbox.map((n) => n.body).join(' ')).toContain(day);
  });

  it('[REVIEW-G S3-3] a completion that failed after a decision is retried by the sweep; a document refused on another ground is never re-run', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    await erase(me, [doc]);
    // the review ends; the completion after the decision "fails" (modelled: the release ran, the erasure did not)
    const hold = (await systemHoldOf(me))!;
    await system(() => app.prisma.docLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedBy: INVESTIGATION_HOLD_PLACER, releaseReason: 'investigation closed' } }));
    await system(() => app.prisma.verificationDocument.updateMany({ where: { legalHoldId: hold.id }, data: { legalHoldId: null } }));
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: doc, closedAt: null }, data: { closedAt: new Date() } }));
    expect((await docRow(doc)).purgedAt).toBeNull();
    const ran = await system(() => service.retryDelayedErasures());
    expect(ran).toBeGreaterThanOrEqual(1);
    expect((await docRow(doc)).purgedAt).not.toBeNull();
    // a second run finds nothing left for this person (the latest outcome is DESTROYED)
    const rows = await system(() => app.prisma.auditLog.count({ where: { userId: me, action: 'DSAR_DOCUMENT_ERASURE' } }));
    await system(() => service.retryDelayedErasures());
    expect(await system(() => app.prisma.auditLog.count({ where: { userId: me, action: 'DSAR_DOCUMENT_ERASURE' } }))).toBe(rows);
  });
  it('[REVIEW-M S2-1 · probe PA] a person released case 1\'s system hold; a NEW identity review case opens on the same group: it must hold the member again', async () => {
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const member = await person();
    const doc = (await submit(member)).id;
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: member, clusterId: root, linkedVia: [] } });
    });
    const case1 = await system(() => app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: {}, complete: true } }));
    await system(() => sweepInvestigationHolds(app.prisma));
    const sys = (await systemHoldOf(member))!;
    // a person releases case 1's system hold (as the PR test does)
    await system(() => app.prisma.docLegalHold.update({ where: { id: sys.id }, data: { releasedAt: new Date(), releasedBy: reviewerB, releaseReason: `Decided: not needed ${RUN}` } }));
    await system(() => app.prisma.verificationDocument.updateMany({ where: { legalHoldId: sys.id }, data: { legalHoldId: null } }));
    // case 1 is decided (retained) and a NEW case opens on the same group (new snapshot)
    await system(() => app.prisma.identityReviewCase.update({ where: { id: case1.id }, data: { status: 'RETAINED', disposition: 'KEEP_REVIEW', reviewedAt: new Date(), reviewedBy: reviewerB, reviewNote: 'retained for probe' } as never }));
    const case2 = await system(() => app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: { members: [{ accountId: member }] }, complete: true } }));
    await system(() => holdIdentityReviewMembers(app.prisma, [case2]));
    await system(() => sweepInvestigationHolds(app.prisma));
    const after = await systemHoldOf(member);
    const res = await erase(member, [doc]);
    const out = outcomeOf(res, doc);
    expect(after).not.toBeNull();
    expect(out.outcome).toBe('REFUSED');
  });

  it('[REVIEW-M S2-2 · probe PB] a successor hold whose investigation is OPEN but whose review date has just passed (renewal due, not yet swept) must still take the documents', async () => {
    const me = await person();
    const x = (await submit(me)).id;
    // hold A (an identity-review system hold) exists FIRST; its investigation is closed (no open case for that group)
    const holdA = await system(() => app.prisma.docLegalHold.create({ data: {
      subjectUserId: me, reason: `INVESTIGATION_OPEN identity-review:cl-gone-${nanoid(6)}`, ownerId: INVESTIGATION_HOLD_PLACER, placedBy: INVESTIGATION_HOLD_PLACER,
      placedAt: new Date(Date.now() - DAY), reviewBy: new Date(Date.now() + 200 * DAY) } }));
    await suspect(x); // the second review B opens and holds X (A kept nothing yet)
    const holdB = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: me, reason: `INVESTIGATION_OPEN second-review:${x}`, releasedAt: null } }));
    expect((await docRow(x)).legalHoldId).toBe(holdB.id);
    // the person asks to erase X: refused on the hold (on the record)
    expect(outcomeOf(await erase(me, [x]), x)).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
    // X now kept by A (e.g. A took it while B's stamp was elsewhere); B's 90-day date has just passed, its review still OPEN
    await system(() => app.prisma.verificationDocument.update({ where: { id: x }, data: { legalHoldId: holdA.id } }));
    // B's 90-day date has just passed (renewal due: the next sweep would renew it), its second review still OPEN.
    // The decision path closes A's investigation at that moment: releaseClosedInvestigationHolds, then the delayed erasure.
    const at = new Date(holdB.reviewBy.getTime() + 3_600_000);
    const freed = await system(() => app.prisma.$transaction((tx) => releaseClosedInvestigationHolds(tx, me, at)));
    await system(() => service.completeDeferredErasures(me, freed));
    const row = await docRow(x);
    expect(row.purgedAt).toBeNull();
    expect(row.legalHoldId).toBe(holdB.id);
  });

  it('[REVIEW-M S4-1 · MD7] a freed document nobody asked to erase is never erased by the release', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    await runWithTenant('swift-default', () => service.rejectDocument(doc, reviewerB, `Photo too dark ${RUN}`, 'UNREADABLE'));
    await system(() => sweepInvestigationHolds(app.prisma, new Date(), undefined, { retryDelayedErasures: () => service.retryDelayedErasures(), onFreed: async (u, ids) => { await service.completeDeferredErasures(u, ids); } }));
    expect((await docRow(doc)).purgedAt).toBeNull();
  });

  it('[REVIEW-M S4-2 · MD3 MD5 MD6] escalate once however often renewed; the notice is sent once a day for the same words; never to a closed account', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    const hold = (await systemHoldOf(me))!;
    let at = new Date(hold.reviewBy.getTime() + DAY);
    for (let i = 0; i < 3; i += 1) {
      await system(() => sweepInvestigationHolds(app.prisma, at));
      at = new Date((await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: hold.id } }))).reviewBy.getTime() + DAY);
    }
    expect(await system(() => app.prisma.auditLog.count({ where: { entityId: hold.id, action: 'RENEW_INVESTIGATION_HOLD' } }))).toBe(3);
    expect(await system(() => app.prisma.auditLog.count({ where: { entityId: hold.id, action: 'ESCALATE_INVESTIGATION_HOLD' } }))).toBe(1);
    const revisitBy = new Date(Date.now() + 30 * DAY);
    await service.notifyErasureDelayed(me, revisitBy);
    await service.notifyErasureDelayed(me, revisitBy);
    expect(await system(() => app.prisma.notification.count({ where: { userId: me, title: 'Your deletion request is delayed' } }))).toBe(1);
    const closed = await person();
    await system(() => app.prisma.user.update({ where: { id: closed }, data: { phone: `deleted:${closed}` } }));
    await service.notifyErasureDelayed(closed, revisitBy);
    expect(await system(() => app.prisma.notification.count({ where: { userId: closed } }))).toBe(0);
  });

  it('[REVIEW-G S3-3] the catch-all reads the LATEST answer: a request answered since on another ground is closed, never re-run', async () => {
    const me = await person();
    const doc = (await submit(me)).id;
    await suspect(doc);
    await erase(me, [doc]); // refused on the hold
    // a later answer refused it on another ground (an AML record, say), and the hold is gone
    await system(() => app.prisma.auditLog.create({ data: { userId: me, action: 'DSAR_DOCUMENT_ERASURE', entity: 'User', entityId: me, changes: { outcomes: [{ documentId: doc, outcome: 'REFUSED', ground: 'AML_RECORD' }] }, createdAt: new Date(Date.now() + 1000) } }));
    const hold = (await systemHoldOf(me))!;
    await system(() => app.prisma.docLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedBy: INVESTIGATION_HOLD_PLACER, releaseReason: 'investigation closed' } }));
    await system(() => app.prisma.verificationDocument.updateMany({ where: { legalHoldId: hold.id }, data: { legalHoldId: null } }));
    const rows = await system(() => app.prisma.auditLog.count({ where: { userId: me, action: 'DSAR_DOCUMENT_ERASURE' } }));
    await system(() => service.retryDelayedErasures());
    expect((await docRow(doc)).purgedAt).toBeNull();
    expect(await system(() => app.prisma.auditLog.count({ where: { userId: me, action: 'DSAR_DOCUMENT_ERASURE' } }))).toBe(rows);
  });

  it('[COORD 10:44Z F S4] the words: plural forms, and the toast counts every kept document, a person\'s holds included', async () => {
    expect(erasureCompletedWords(2)).toEqual({ title: 'Your documents have been deleted', body: 'We have now deleted the documents you asked us to delete.' });
    const at = new Date('2027-09-30T15:00:00Z');
    expect(accountClosedKeptWords(at, 3)).toBe('Account closed. Until at least 30 Sep 2027, 3 documents are kept for a check, then deleted.');
    // an account with one document under the review's hold and one under a person's hold: both are counted
    const me = await person();
    const suspected = (await submit(me)).id;
    const courtHeld = (await submit(me, OTHER_TYPE)).id;
    await system(() => placeDocLegalHold(app.prisma, { subjectUserId: me, documentIds: [courtHeld], reason: `Court order ${RUN}`, ownerId: reviewerB, placedBy: reviewerB, reviewBy: new Date(Date.now() + 30 * DAY) }));
    await suspect(suspected);
    const accounts = new AccountService({ prisma: app.prisma, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as never } as never);
    const result = await accounts.deleteAccount(me) as { message: string };
    expect(result.message).toMatch(/^Account closed\. Until at least .+, 2 documents are kept for a check, then deleted\.$/);
  });

  it('[COORD 10:44Z F S4-2] the daily job wires the renewal notice to the requester-only path (a revert turns this red)', () => {
    const queue = readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8');
    const sweep = queue.slice(queue.indexOf('await sweepInvestigationHolds(ctx.prisma'), queue.indexOf('await sweepInvestigationHolds(ctx.prisma') + 1600);
    expect(sweep).toMatch(/notifyPerson: \(userId, revisitBy, holdId\) => verification\.notifyRenewalIfDelayed\(userId, revisitBy, holdId\)/);
    expect(sweep).toContain('retryDelayedErasures: () => verification.retryDelayedErasures()');
    expect(sweep).not.toContain('notifyErasureDelayed');
  });

  it('[REVIEW-M S4-1 · MN4] a renewal tells a requester only when THAT hold keeps the requested document', async () => {
    const me = await person();
    const requested = (await submit(me)).id;
    const other = (await submit(me, OTHER_TYPE)).id;
    await suspect(requested); // hold A keeps the requested document
    await erase(me, [requested]); // refused on the hold: a delayed request on record
    await suspect(other); // hold B keeps another document
    const holdA = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: me, reason: `INVESTIGATION_OPEN second-review:${requested}`, releasedAt: null } }));
    const holdB = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: me, reason: `INVESTIGATION_OPEN second-review:${other}`, releasedAt: null } }));
    await system(() => app.prisma.docLegalHold.update({ where: { id: holdA.id }, data: { reviewBy: new Date(Date.now() + 300 * DAY) } }));
    const sent = () => system(() => app.prisma.notification.count({ where: { userId: me, title: 'Your deletion request is delayed' } }));
    const before = await sent();
    const notifyPerson = (userId: string, revisitBy: Date, holdId: string) => service.notifyRenewalIfDelayed(userId, revisitBy, holdId);
    // only B is due: B keeps no requested document, so nothing is sent
    await system(() => sweepInvestigationHolds(app.prisma, new Date(holdB.reviewBy.getTime() + DAY), undefined, { notifyPerson }));
    expect(await sent()).toBe(before);
    // A comes due: it keeps the requested document, so the requester is told A's new date
    const at = new Date(Date.now() + 301 * DAY);
    await system(() => sweepInvestigationHolds(app.prisma, at, undefined, { notifyPerson }));
    expect(await sent()).toBe(before + 1);
  });

  it('[REVIEW-G S4 · G6] the account-close lock check alone keeps a document an open identity review needs (no bytes, no hold yet)', async () => {
    const root = `cl-${nanoid(8)}`; clusters.push(root);
    const me = await person();
    const doc = (await submit(me)).id;
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc }, data: { fileUrl: '' } })); // no bytes: the record close is the only step
    await system(async () => {
      await app.prisma.identityCluster.create({ data: { id: root, authorityReviewRequired: true } });
      await app.prisma.identityClusterMember.create({ data: { accountId: me, clusterId: root, linkedVia: [] } });
      await app.prisma.identityReviewCase.create({ data: { tenantId: 'swift-default', clusterId: root, snapshotDigest: nanoid(8), snapshot: {}, complete: true } });
    });
    // the review's hold has not reached this person yet (modelled: the pre-erasure placement found nothing to do)
    const spy = vi.spyOn(investigationHold, 'holdForOpenIdentityReviews').mockResolvedValue(0);
    try {
      const accounts = new AccountService({ prisma: app.prisma, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as never } as never);
      await accounts.deleteAccount(me);
    } finally { spy.mockRestore(); }
    expect((await docRow(doc)).legalHoldId).toBeNull();
    expect((await docRow(doc)).purgedAt).toBeNull();
  });

  it('[COORD 16:02Z] the catch-all keeps a durable watermark: it reads only from the oldest request still waiting, and that request is still finished when its hold ends', async () => {
    // an older request that is settled (the review ended and the erasure ran)
    const settled = await person();
    const settledDoc = (await submit(settled)).id;
    await suspect(settledDoc);
    await erase(settled, [settledDoc]);
    await runWithTenant('swift-default', () => service.rejectDocument(settledDoc, reviewerB, `Photo too dark ${RUN}`, 'UNREADABLE'));
    expect((await docRow(settledDoc)).purgedAt).not.toBeNull();
    // a later request still waiting on its review
    const waiting = await person();
    const waitingDoc = (await submit(waiting)).id;
    await suspect(waitingDoc);
    await erase(waiting, [waitingDoc]);
    const waitingRow = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { userId: waiting, action: 'DSAR_DOCUMENT_ERASURE' }, orderBy: { createdAt: 'asc' } }));
    await system(() => service.retryDelayedErasures());
    // the watermark sits at the oldest request still waiting: nothing older is read again
    const mark = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { action: 'DSAR_DELAYED_WATERMARK' }, orderBy: { createdAt: 'desc' } }));
    expect(new Date((mark.changes as { since: string }).since).getTime()).toBeLessThanOrEqual(waitingRow.createdAt.getTime());
    const since = new Date((mark.changes as { since: string }).since).getTime();
    // (other requests in this database may still wait, so the mark may sit earlier than this person's: never later)
    const read: number[] = [];
    const notDelayed: string[] = [];
    const original = app.prisma.auditLog.findMany.bind(app.prisma.auditLog);
    const spy = vi.spyOn(app.prisma.auditLog, 'findMany').mockImplementation((async (args: Parameters<typeof original>[0]) => {
      const rows = await original(args as never);
      if ((args as { where?: { action?: string } } | undefined)?.where?.action === 'DSAR_DOCUMENT_ERASURE' && (args as { select?: { createdAt?: boolean } }).select?.createdAt) {
        for (const r of rows as Array<{ id: string; createdAt: Date; changes: { outcomes?: Array<{ outcome?: string; ground?: string }> } }>) {
          read.push(r.createdAt.getTime());
          // only answers that delayed something are read (a fully destroyed or refused-elsewhere answer never is)
          if (!(r.changes?.outcomes ?? []).some((o) => o.outcome === 'REFUSED' && o.ground === 'LEGAL_HOLD')) notDelayed.push(r.id);
        }
      }
      return rows;
    }) as never);
    try {
      await system(() => service.retryDelayedErasures());
    } finally { spy.mockRestore(); }
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((t) => t >= since)).toBe(true); // nothing behind the mark is read again
    expect(notDelayed).toEqual([]);
    // a mark that has passed a settled request: once nothing older waits, it is never read again
    const settledRow = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { userId: settled, action: 'DSAR_DOCUMENT_ERASURE' }, orderBy: { createdAt: 'asc' } }));
    await system(() => app.prisma.auditLog.create({ data: { userId: null, action: 'DSAR_DELAYED_WATERMARK', entity: 'System', entityId: 'dsar-delayed-erasures', changes: { since: new Date(settledRow.createdAt.getTime() + 1).toISOString() } } }));
    read.length = 0;
    const spy2 = vi.spyOn(app.prisma.auditLog, 'findMany').mockImplementation((async (args: Parameters<typeof original>[0]) => {
      const rows = await original(args as never);
      if ((args as { where?: { action?: string } } | undefined)?.where?.action === 'DSAR_DOCUMENT_ERASURE' && (args as { select?: { createdAt?: boolean } }).select?.createdAt) {
        read.push(...(rows as Array<{ createdAt: Date }>).map((r) => r.createdAt.getTime()));
      }
      return rows;
    }) as never);
    try {
      await system(() => service.retryDelayedErasures());
    } finally { spy2.mockRestore(); }
    expect(read).not.toContain(settledRow.createdAt.getTime());
    // the waiting request becomes unheld much later (a person releases its hold): it is still finished
    const hold = (await systemHoldOf(waiting))!;
    await system(() => releaseDocLegalHold(app.prisma, { holdId: hold.id, releasedBy: reviewerB, reason: `Not needed ${RUN}` }));
    await system(() => service.retryDelayedErasures());
    expect((await docRow(waitingDoc)).purgedAt).not.toBeNull();
  });

  it('[COORD 16:35Z race] a request written with an earlier time but committed after a run read still gets finished on the next run', async () => {
    const latestMark = async () => new Date(((await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { action: 'DSAR_DELAYED_WATERMARK' }, orderBy: { createdAt: 'desc' } }))).changes as { since: string }).since).getTime();
    // a clean slate: the earlier tests' requests no longer wait (a newer answer closes each), and an earlier test set
    // the mark ahead by hand (a deliberate fixture): start this one from a day back
    const earlier = await system(() => app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true, userId: true } }));
    for (const userId of new Set(earlier.map((d) => d.userId))) {
      await system(() => app.prisma.auditLog.create({ data: { userId, action: 'DSAR_DOCUMENT_ERASURE', entity: 'User', entityId: userId,
        changes: { outcomes: earlier.filter((d) => d.userId === userId).map((d) => ({ documentId: d.id, outcome: 'REFUSED', ground: 'AML_RECORD' })) } } }));
    }
    await system(() => app.prisma.auditLog.create({ data: { userId: null, action: 'DSAR_DELAYED_WATERMARK', entity: 'System', entityId: 'dsar-delayed-erasures', changes: { since: new Date(Date.now() - 86_400_000).toISOString() } } }));
    await system(() => service.retryDelayedErasures());
    const [{ now }] = await system(() => app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`);
    // a request whose row carries a time from just before the run started, committed only now (after its read)
    const me = await person();
    const doc = (await submit(me)).id;
    await system(() => app.prisma.auditLog.create({ data: { userId: me, action: 'DSAR_DOCUMENT_ERASURE', entity: 'User', entityId: me,
      changes: { outcomes: [{ documentId: doc, outcome: 'REFUSED', ground: 'LEGAL_HOLD' }] }, createdAt: new Date(now.getTime() - 60_000) } }));
    // the mark never jumped past it: it stays at least the commit margin behind the database's clock
    expect(await latestMark()).toBeLessThanOrEqual(now.getTime() - 9 * 60_000);
    // and the app's clock does not move it: with the app an hour fast, a run still marks by the database's clock
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    try {
      await system(() => service.retryDelayedErasures());
    } finally { vi.useRealTimers(); }
    expect(await latestMark()).toBeLessThanOrEqual(now.getTime() - 9 * 60_000 + 120_000);
    await system(() => service.retryDelayedErasures());
    expect((await docRow(doc)).purgedAt).not.toBeNull();
  });

  it('[COORD 16:35Z] the mark is monotonic: a run never moves it backwards, and two runs never overlap', async () => {
    await system(() => service.retryDelayedErasures());
    const marks = async () => (await system(() => app.prisma.auditLog.findMany({ where: { action: 'DSAR_DELAYED_WATERMARK' }, orderBy: { createdAt: 'asc' } })))
      .map((r) => new Date((r.changes as { since: string }).since).getTime());
    const before = await marks();
    // one run at a time: of two runs started together, only one does the work
    const work = vi.spyOn(service as unknown as { finishDelayedSince: (...a: unknown[]) => Promise<unknown> }, 'finishDelayedSince');
    try {
      await Promise.all([system(() => service.retryDelayedErasures()), system(() => service.retryDelayedErasures())]);
      expect(work).toHaveBeenCalledTimes(1);
    } finally { work.mockRestore(); }
    const after = await marks();
    for (let i = Math.max(1, before.length); i < after.length; i += 1) expect(after[i]!, `mark ${i}`).toBeGreaterThanOrEqual(after[i - 1]!);
    // a mark ahead of what a run would compute is never moved backwards by it
    const [{ now }] = await system(() => app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`);
    const ahead = new Date(now.getTime() - 60_000);
    await system(() => app.prisma.auditLog.create({ data: { userId: null, action: 'DSAR_DELAYED_WATERMARK', entity: 'System', entityId: 'dsar-delayed-erasures', changes: { since: ahead.toISOString() } } }));
    await system(() => service.retryDelayedErasures());
    const last = (await marks()).at(-1)!;
    expect(last).toBeGreaterThanOrEqual(ahead.getTime());
  });
});
