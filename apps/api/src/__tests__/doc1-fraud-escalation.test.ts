/**
 * [DOC-1 §24 · P24] test_fraud_suspension_has_human_review_route — DOC-INV-33.
 *
 * A fraud-class verdict is SUSPICION: the first reviewer's reject escalates the
 * case to SECOND_REVIEW and the document stays pending; the same reviewer may
 * not confirm; a different reviewer's confirmation is the rejection and, in the
 * same transaction, the fraud case, the legal hold on the person's documents
 * (bytes preserved) and the founder-pending enforcement hold. The person hears
 * one generic message that never names the signal, and has a human-review
 * route: the appeal. Referral is never automatic. A non-fraud reject is a
 * plain rejection, as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService, FRAUD_GENERIC_TEXT, FRAUD_HOLD_REVIEW_DAYS } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { hasActiveHold, DOC_FRAUD_REASON_CODE } from '../modules/integrity/enforcement';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Second look at the scan ${RUN}: fonts and kerning differ across the number block`;

let app: FastifyInstance;
let adminApp: FastifyInstance;
let service: VerificationService;
const tokens = new Map<string, string>();
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-fraud-escalation-test');

class ManualKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

async function session(userId: string, role: string, n: number) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `fraud-${RUN}-${n}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  tokens.set(userId, token);
}
async function admin(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59275${NUM}${n}`, firstName: 'Fraud', lastName: `Reviewer${n}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  users.push(u.id); await session(u.id, 'SUPER_ADMIN', n); return u.id;
}
async function subject(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59275${NUM}${n}`, firstName: 'Sub', lastName: `Ject${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id); await session(u.id, 'VENDOR_OWNER', n); return u.id;
}
async function pendingCase(userId: string) {
  const doc = await runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', 'business_registration', `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
  const kase = await system(() => app.prisma.reviewCase.findFirstOrThrow({ where: { submissionId: doc.id, closedAt: null } }));
  return { doc, kase };
}
const reject = (adminId: string, docId: string, reasonCode: string) => adminApp.inject({
  method: 'PUT', url: `/api/v1/admin/verification/${docId}/reject`, payload: { reason: REASON, reasonCode },
  headers: { authorization: `Bearer ${tokens.get(adminId)}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const appeal = (userId: string) => app.inject({ method: 'POST', url: '/api/v1/verification/appeal', payload: { note: `I uploaded my own certificate ${RUN}` }, headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' } });
const docRow = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }));
const caseRow = (id: string) => system(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id }, include: { decisions: { orderBy: { decidedAt: 'asc' } } } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualKyc());
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.fraudCase.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close();
  await app.close();
});

describe('[DOC-1 P24] fraud escalation: suspicion → second review → confirmation with hold, and a human-review route', () => {
  let a = ''; let b = ''; let s = '';
  let docId = ''; let caseId = '';

  it('the first reviewer’s fraud-class verdict escalates: the case goes to SECOND_REVIEW unassigned at raised priority, an ESCALATE decision is recorded, the document stays PENDING — no hold, no case, no enforcement yet', async () => {
    a = await admin(1); b = await admin(2); s = await subject(3);
    const { doc, kase } = await pendingCase(s);
    docId = doc.id; caseId = kase.id;
    const res = await reject(a, docId, 'SUSPECTED_TAMPERING');
    expect(res.statusCode).toBe(200);
    expect((await docRow(docId)).status).toBe('PENDING');
    const c = await caseRow(caseId);
    expect([c.queue, c.priority, c.assignedTo, c.closedAt]).toEqual(['SECOND_REVIEW', 20, null, null]);
    expect(c.decisions.map((d) => [d.outcome, d.reasonCode, d.actorFacingCategory, d.reviewerId])).toEqual([['ESCALATE', 'SUSPECTED_TAMPERING', 'UNVERIFIABLE', a]]);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'ESCALATE_VERIFICATION_DOC', entityId: docId } }))).toBe(1);
    expect(await system(() => app.prisma.fraudCase.count({ where: { subjectUserId: s } }))).toBe(0);
    expect((await docRow(docId)).legalHoldId).toBeNull();
    expect((await hasActiveHold(app.prisma, s)).held).toBe(false);
  });

  it('the reviewer who raised the suspicion cannot confirm it (403 SECOND_REVIEWER_REQUIRED)', async () => {
    const res = await reject(a, docId, 'DUPLICATE');
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code ?? res.json().code).toBe('SECOND_REVIEWER_REQUIRED');
    expect((await docRow(docId)).status).toBe('PENDING');
  });

  it('a different reviewer confirms: the rejection, the fraud case, the legal hold on the person’s documents and the founder-pending hold land together; the person hears the generic message only', async () => {
    const res = await reject(b, docId, 'DUPLICATE');
    expect(res.statusCode).toBe(200);
    const doc = await docRow(docId);
    expect(doc.status).toBe('REJECTED');
    expect(doc.legalHoldId).not.toBeNull();
    const fraud = await system(() => app.prisma.fraudCase.findFirstOrThrow({ where: { subjectUserId: s } }));
    expect(fraud).toMatchObject({ submissionId: docId, caseId, reasonCode: 'DUPLICATE', confirmedBy: b, referral: 'NONE', legalHoldId: doc.legalHoldId, tenantId: 'swift-default' });
    expect(fraud.linkedAccountIds as string[]).toContain(s);
    const hold = await system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: doc.legalHoldId! } }));
    expect([hold.ownerId, hold.placedBy, hold.releasedAt]).toEqual([b, b, null]);
    const days = (hold.reviewBy.getTime() - hold.placedAt.getTime()) / DAY;
    expect(Math.round(days)).toBe(FRAUD_HOLD_REVIEW_DAYS);
    const enforcement = await system(() => app.prisma.enforcementAction.findFirstOrThrow({ where: { id: fraud.enforcementId! } }));
    expect([enforcement.level, enforcement.reasonCode, enforcement.decidedBy, enforcement.accountId]).toEqual(['BLOCK_PENDING_FOUNDER', DOC_FRAUD_REASON_CODE, b, s]);
    expect((await hasActiveHold(app.prisma, s)).held).toBe(true);
    const c = await caseRow(caseId);
    expect(c.closedAt).toBeInstanceOf(Date);
    expect(c.decisions.at(-1)).toMatchObject({ outcome: 'REJECT', reasonCode: 'DUPLICATE', actorFacingCategory: 'UNVERIFIABLE', reviewerId: b });
    const notes = await system(() => app.prisma.notification.findMany({ where: { userId: s } }));
    const rejected = notes.filter((n) => (n.data as { kind?: string } | null)?.kind === 'verification_rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const n of rejected) {
      expect(n.body).toContain(FRAUD_GENERIC_TEXT);
      expect(n.body.toLowerCase()).not.toMatch(/duplicate|tamper|forged|altered|another account|does not match/);
    }
  });

  it('DOC-INV-33: the suspended person has a human-review route — the appeal opens on the document-fraud hold; a trial-integrity fraud-cluster hold stays non-appealable', async () => {
    const res = await appeal(s);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.appealed).toBe(true);
    const enforcement = await system(() => app.prisma.enforcementAction.findFirstOrThrow({ where: { accountId: s, reasonCode: DOC_FRAUD_REASON_CODE } }));
    expect(enforcement.appeal).toBe('OPEN');
    const t = await subject(4);
    await system(() => app.prisma.enforcementAction.create({ data: { accountId: t, level: 'BLOCK_PENDING_FOUNDER', reasonCode: 'FRAUD_CLUSTER_REREGISTRATION', signalsFired: [] as never, decidedBy: 'SYSTEM' } }));
    const refused = await appeal(t);
    expect(refused.statusCode).toBe(404);
  });

  it('a machine-raised SECOND_REVIEW case (a collision) needs no earlier reviewer: the first human confirmation is the rejection', async () => {
    const u = await subject(5);
    const { doc, kase } = await pendingCase(u);
    await system(() => app.prisma.reviewCase.update({ where: { id: kase.id }, data: { queue: 'SECOND_REVIEW' } }));
    const res = await reject(a, doc.id, 'FACE_MISMATCH');
    expect(res.statusCode).toBe(200);
    expect((await docRow(doc.id)).status).toBe('REJECTED');
    expect(await system(() => app.prisma.fraudCase.count({ where: { subjectUserId: u, reasonCode: 'FACE_MISMATCH' } }))).toBe(1);
  });

  it('a non-fraud reject is a plain rejection: no escalation, no fraud case, no hold', async () => {
    const v = await subject(6);
    const { doc } = await pendingCase(v);
    const res = await reject(a, doc.id, 'EXPIRED');
    expect(res.statusCode).toBe(200);
    const row = await docRow(doc.id);
    expect([row.status, row.legalHoldId]).toEqual(['REJECTED', null]);
    expect(await system(() => app.prisma.fraudCase.count({ where: { subjectUserId: v } }))).toBe(0);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'REJECT_VERIFICATION_DOC', entityId: doc.id } }))).toBe(1);
  });
});
