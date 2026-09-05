/**
 * [DOC-1 §8.6 · P8-6] test_reviewer_recusal_enforced_server_side — DOC-INV-8.
 *
 * A reviewer may not claim or decide a case where the subject shares an
 * identity-graph node with the reviewer's own account. The graph's cluster is
 * the one definition of "the same person"; recusal is that definition applied
 * to reviewer and subject, enforced in the service at claim time and again at
 * decision time — never in the UI. A case another reviewer holds is not taken
 * over; only its holder releases it.
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
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { isRecused } from '../modules/verification/recusal';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Reviewed against the registry ${RUN}; the document is legible and current`;

let app: FastifyInstance;
let adminApp: FastifyInstance;
let service: VerificationService;
const tokens = new Map<string, string>();
const users: string[] = [];
let clusterId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-reviewer-recusal-test');

class ManualKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

async function admin(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59274${NUM}${n}`, firstName: 'Rev', lastName: `Iewer${n}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rec-${RUN}-${n}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  tokens.set(u.id, token);
  return u.id;
}
async function subject(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59274${NUM}${n}`, firstName: 'Sub', lastName: `Ject${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
/** A pending document, and the review case P4-5 opened for it. */
async function pendingCase(userId: string) {
  const doc = await runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', 'business_registration', `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
  const kase = await system(() => app.prisma.reviewCase.findFirstOrThrow({ where: { submissionId: doc.id, closedAt: null } }));
  return { doc, kase };
}
const post = (adminId: string, path: string) => adminApp.inject({ method: 'POST', url: `/api/v1/admin/verification/cases/${path}`, payload: {}, headers: { authorization: `Bearer ${tokens.get(adminId)}`, 'content-type': 'application/json' } });
const approve = (adminId: string, docId: string) => adminApp.inject({ method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, payload: {}, headers: { authorization: `Bearer ${tokens.get(adminId)}`, 'content-type': 'application/json', 'x-swift-reason': REASON } });
const caseRow = (id: string) => system(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
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
    if (clusterId) { await app.prisma.identityClusterMember.deleteMany({ where: { clusterId } }); await app.prisma.identityCluster.deleteMany({ where: { id: clusterId } }); }
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close();
  await app.close();
});

describe('[DOC-1 P8-6] reviewer recusal, enforced server-side (test_reviewer_recusal_enforced_server_side)', () => {
  let linkedReviewer = '';
  let otherReviewer = '';
  let linkedSubject = '';

  it('the graph is the definition: a reviewer in the subject’s identity cluster is recused; an unlinked one is not; a reviewer is always recused from their own case', async () => {
    linkedReviewer = await admin(1);
    otherReviewer = await admin(2);
    linkedSubject = await subject(3);
    const cluster = await system(() => app.prisma.identityCluster.create({ data: {
      members: { create: [linkedReviewer, linkedSubject].map((accountId) => ({ accountId, linkedVia: [{ type: 'DEVICE', strength: 1, matchedAccountId: linkedSubject, at: new Date().toISOString() }] })) },
    } }));
    clusterId = cluster.id;
    expect(await isRecused(app.prisma, linkedReviewer, linkedSubject)).toBe(true);
    expect(await isRecused(app.prisma, otherReviewer, linkedSubject)).toBe(false);
    expect(await isRecused(app.prisma, otherReviewer, otherReviewer)).toBe(true);
  });

  it('claim: the linked reviewer is refused (403 REVIEWER_RECUSED) and the case stays unassigned; the unlinked reviewer claims it, and the claim is logged', async () => {
    const { kase } = await pendingCase(linkedSubject);
    const refused = await post(linkedReviewer, `${kase.id}/claim`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error?.code ?? refused.json().code).toBe('REVIEWER_RECUSED');
    expect((await caseRow(kase.id)).assignedTo).toBeNull();
    const ok = await post(otherReviewer, `${kase.id}/claim`);
    expect(ok.statusCode).toBe(200);
    const row = await caseRow(kase.id);
    expect(row.assignedTo).toBe(otherReviewer);
    expect(row.assignedAt).toBeInstanceOf(Date);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'CLAIM_REVIEW_CASE', entityId: kase.id, userId: otherReviewer } }))).toBe(1);
  });

  it('decision: the linked reviewer cannot approve the subject’s document even without claiming — the document stays PENDING; the unlinked reviewer can', async () => {
    const { doc } = await pendingCase(linkedSubject);
    const refused = await approve(linkedReviewer, doc.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error?.code ?? refused.json().code).toBe('REVIEWER_RECUSED');
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('PENDING');
    const ok = await approve(otherReviewer, doc.id);
    expect(ok.statusCode).toBe(200);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('APPROVED');
  });

  it('a case another reviewer holds is not taken over (409 CASE_CLAIMED); only its holder releases it (409 NOT_CASE_HOLDER otherwise); a decided case cannot be claimed', async () => {
    const unrelated = await subject(4);
    const { doc, kase } = await pendingCase(unrelated);
    expect((await post(otherReviewer, `${kase.id}/claim`)).statusCode).toBe(200);
    const takeover = await post(linkedReviewer, `${kase.id}/claim`);
    expect(takeover.statusCode).toBe(409);
    expect(takeover.json().error?.code ?? takeover.json().code).toBe('CASE_CLAIMED');
    expect((await caseRow(kase.id)).assignedTo).toBe(otherReviewer);
    expect((await post(linkedReviewer, `${kase.id}/release`)).statusCode).toBe(409);
    expect((await post(otherReviewer, `${kase.id}/release`)).statusCode).toBe(200);
    expect((await caseRow(kase.id)).assignedTo).toBeNull();
    expect((await post(linkedReviewer, `${kase.id}/claim`)).statusCode).toBe(200); // unlinked to this subject
    expect((await approve(linkedReviewer, doc.id)).statusCode).toBe(200);
    const closed = await post(otherReviewer, `${kase.id}/claim`);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error?.code ?? closed.json().code).toBe('CASE_CLOSED');
  });

  it('the routes are registered as C2 workflow actions with the case as the audited entity', () => {
    for (const key of ['POST /verification/cases/:id/claim', 'POST /verification/cases/:id/release']) {
      expect(ADMIN_ROUTE_AUTHORITY[key]?.cls).toBe('C2');
      expect(ADMIN_ROUTE_AUTHORITY[key]?.entity?.model).toBe('reviewCase');
    }
  });
});
