import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { loginWithOtp, requestOtp } from './helpers/otp';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { injectWithApproval } from './helpers/admin-approval';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { previousDecisions } from '../modules/verification/previous-decision';

// ---------------------------------------------------------------------------
// [NO-DEAD-ENDS · owner, 6 Oct] "Remember the issue for them to be able to
// resubmit the document rejected rather than restart application or get
// stuck."
//
// One store owner's application, end to end through the real routes, in the
// exact request shapes the store build in review (build 9) sends:
//   every checklist document goes in → a reviewer approves all but one and
//   rejects that one with a reason → the owner sees the reason on that one
//   document, the rest stay approved, the store stays the same pending store
//   → the owner re-submits ONLY that document → it lands in the Review Center
//   queue marked as a re-submission, with the earlier reason beside it → the
//   reviewer approves it and the store goes live. Nothing restarts.
// ---------------------------------------------------------------------------

const OWNER_PHONE = '+59200199201';
const REJECT_REASON = 'Photo is blurry: retake it in daylight with all four corners showing';

let app: FastifyInstance;
let adminToken = '';
let ownerToken = '';
let ownerUserId = '';
let vendorId = '';
let rejectedDocType = '';
let rejectedDocId = '';
let resubmittedDocId = '';

async function cleanup() {
  const ids = (await app.prisma.user.findMany({ where: { phone: OWNER_PHONE }, select: { id: true } })).map((u) => u.id);
  if (ids.length === 0) return;
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.subscription.deleteMany({ where: { vendor: { owner: { userId: { in: ids } } } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: ids } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}
/** Build 9's JSON POST. */
function post(url: string, payload: unknown, token: string) {
  return app.inject({
    method: 'POST', url, payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}
function admin(method: 'GET' | 'PUT', url: string, payload?: Record<string, unknown>) {
  return injectWithApproval(app, {
    method, url, ...(payload ? { payload } : {}),
    headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
}
/** Exactly build 9's document step: the upload pointer (modelled), then POST /verification/documents. */
async function submit(docType: string, marker: string) {
  const fileUrl = await ownedVerificationFixture(app.prisma, ownerUserId, marker);
  return post('/api/v1/verification/documents', { role: 'SUPERMARKET', docType, fileUrl, consent: true, privacyNoticeVersion: 'v1' }, ownerToken);
}
async function status() {
  const res = await get('/api/v1/verification/status?role=SUPERMARKET', ownerToken);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { checklist: string[]; missing: string[]; roleVerified: boolean; documents: Array<{ id: string; docType: string; status: string; reviewNote: string | null; createdAt: string }> };
}
/** What the app's checklist card shows for a type: the newest document of it (the server lists newest first). */
function shownFor(docs: Array<{ docType: string }>, docType: string) {
  return docs.find((d) => d.docType === docType) as { id: string; status: string; reviewNote: string | null } | undefined;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await cleanup();

  const code = await requestOtp(app, OWNER_PHONE);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', payload: { phone: OWNER_PHONE, code }, headers: { 'content-type': 'application/json' } });
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { phone: OWNER_PHONE, registrationProof: verified.json().data.registrationProof, firstName: 'Resubmit', lastName: 'Owner', countryCode: 'GY', role: 'CUSTOMER', acceptTerms: true },
    headers: { 'content-type': 'application/json' },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  ownerUserId = reg.json().data.user.id;
  ownerToken = reg.json().data.tokens.accessToken;
  await signupSelfieFixture(app.prisma, ownerUserId);
  const created = await post('/api/v1/partner/become', {
    role: 'VENDOR', acceptAgreement: true,
    business: { name: 'Resubmit Mini Mart', vendorType: 'SUPERMARKET', phone: '+5926009876', addressLine1: '3 Water Street', city: 'Georgetown', latitude: 6.8013, longitude: -58.1551 },
  }, ownerToken);
  expect(created.statusCode, created.body).toBe(201);
  const profile = await get('/api/v1/vendor/profile', ownerToken);
  vendorId = profile.json().data.vendors[0].id;

  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('a store owner re-submits one rejected document without restarting the application', () => {
  it('every checklist document goes in; a reviewer approves all but one and rejects that one with a reason', async () => {
    const before = await status();
    for (const docType of before.missing) {
      const res = await submit(docType, docType);
      expect(res.statusCode, res.body).toBe(201);
    }
    const queued = (await status()).documents;
    rejectedDocType = before.checklist[0]!;
    for (const docType of before.checklist) {
      const doc = shownFor(queued, docType)!;
      if (docType === rejectedDocType) {
        rejectedDocId = doc.id;
        const rejected = await admin('PUT', `/api/v1/admin/verification/${doc.id}/reject`, { reason: REJECT_REASON });
        expect(rejected.statusCode, rejected.body).toBe(200);
        expect(rejected.json().data.status).toBe('REJECTED');
      } else {
        const approved = await admin('PUT', `/api/v1/admin/verification/${doc.id}/approve`, {});
        expect(approved.statusCode, approved.body).toBe(200);
      }
    }
  });

  it('the owner sees the reason on that one document; the others stay approved; the store is the same pending store', async () => {
    const now = await status();
    const shown = shownFor(now.documents, rejectedDocType)!;
    expect(shown.status).toBe('REJECTED');
    expect(shown.reviewNote).toBe(REJECT_REASON);
    expect(now.missing).toEqual([rejectedDocType]);
    for (const docType of now.checklist.filter((t) => t !== rejectedDocType)) {
      expect(shownFor(now.documents, docType)?.status, docType).toBe('APPROVED');
    }
    const profile = await get('/api/v1/vendor/profile', ownerToken);
    expect(profile.json().data.vendors).toHaveLength(1);
    expect(profile.json().data.vendors[0]).toMatchObject({ id: vendorId, status: 'PENDING_APPROVAL' });
  });

  it('re-submitting ONLY that document is accepted (build 9 shape) and touches nothing else', async () => {
    const approvedBefore = await app.prisma.verificationDocument.findMany({
      where: { userId: ownerUserId, status: 'APPROVED' }, select: { id: true, docType: true, status: true, updatedAt: true }, orderBy: { id: 'asc' },
    });

    const res = await submit(rejectedDocType, `${rejectedDocType}-retake`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
    resubmittedDocId = res.json().data.id;
    expect(resubmittedDocId).not.toBe(rejectedDocId);

    const approvedAfter = await app.prisma.verificationDocument.findMany({
      where: { userId: ownerUserId, status: 'APPROVED' }, select: { id: true, docType: true, status: true, updatedAt: true }, orderBy: { id: 'asc' },
    });
    expect(approvedAfter, 'no approved document was reset or replaced').toEqual(approvedBefore);
    const now = await status();
    expect(shownFor(now.documents, rejectedDocType)).toMatchObject({ id: resubmittedDocId, status: 'PENDING' });
    // The earlier verdict is kept as history, not erased.
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: rejectedDocId } })).status).toBe('REJECTED');
  });

  it('the reviewer sees it in the Review Center queue AS a re-submission, with the earlier reason', async () => {
    const queue = await admin('GET', '/api/v1/admin/verification/queue?status=PENDING&limit=100');
    expect(queue.statusCode, queue.body).toBe(200);
    const row = (queue.json().data as Array<Record<string, any>>).find((d) => d['id'] === resubmittedDocId);
    expect(row, 'the re-submitted document is in the queue').toBeDefined();
    expect(row!['previousDecision']).toMatchObject({
      documentId: rejectedDocId,
      kind: 'RESUBMITTED_AFTER_REJECTION',
      status: 'REJECTED',
      reviewNote: REJECT_REASON,
    });
  });

  it('approving it completes the checklist and the store goes live — the same store, no restart', async () => {
    const approved = await admin('PUT', `/api/v1/admin/verification/${resubmittedDocId}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await status()).roleVerified).toBe(true);
    const profile = await get('/api/v1/vendor/profile', ownerToken);
    expect(profile.json().data.vendors[0]).toMatchObject({ id: vendorId, status: 'ACTIVE' });
  });
});

describe('previousDecisions (pure)', () => {
  const at = (iso: string) => new Date(iso);
  const queued = [
    { id: 'new-id', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', createdAt: at('2026-10-06T12:00:00Z') },
    { id: 'first', userId: 'u2', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', createdAt: at('2026-10-06T12:00:00Z') },
  ];
  it('picks the newest earlier decision of the same applicant and type, and names a rejection a re-submission', () => {
    const found = previousDecisions(queued, [
      { id: 'old-reject', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', status: 'REJECTED', reviewNote: 'old', reviewedAt: at('2026-10-01T00:00:00Z'), createdAt: at('2026-10-01T00:00:00Z') },
      { id: 'last-reject', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', status: 'REJECTED', reviewNote: 'blurry', reviewedAt: at('2026-10-05T00:00:00Z'), createdAt: at('2026-10-05T00:00:00Z') },
      { id: 'other-type', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'tin_certificate', status: 'REJECTED', reviewNote: 'x', reviewedAt: null, createdAt: at('2026-10-05T06:00:00Z') },
      { id: 'other-person', userId: 'u3', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', status: 'REJECTED', reviewNote: 'y', reviewedAt: null, createdAt: at('2026-10-05T06:00:00Z') },
      { id: 'later', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', status: 'REJECTED', reviewNote: 'z', reviewedAt: null, createdAt: at('2026-10-07T00:00:00Z') },
    ]);
    expect(found.get('new-id')).toMatchObject({ documentId: 'last-reject', kind: 'RESUBMITTED_AFTER_REJECTION', reviewNote: 'blurry' });
    expect(found.has('first'), 'a first upload has no previous decision').toBe(false);
  });
  it.each([
    { role: 'MOVER', subjectId: null },
    { role: 'CUSTOMER', subjectId: 'another-subject' },
  ] as const)('does not attach evidence from another role or subject: %j', (other) => {
    const matching = { ...queued[0]!, id: 'matching', status: 'REJECTED', reviewNote: 'matching decision', reviewedAt: null, createdAt: at('2026-10-01T00:00:00Z') };
    const wrong = { ...matching, ...other, id: 'wrong', createdAt: at('2026-10-05T00:00:00Z') };
    expect(previousDecisions([queued[0]!], [matching, wrong]).get('new-id')?.documentId).toBe('matching');
  });
  it('an earlier approved or expired document makes it a renewal', () => {
    const found = previousDecisions([queued[0]!], [
      { id: 'expired', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', status: 'EXPIRED', reviewNote: null, reviewedAt: null, createdAt: at('2025-10-01T00:00:00Z') },
    ]);
    expect(found.get('new-id')).toMatchObject({ kind: 'RENEWAL', status: 'EXPIRED' });
  });
});

describe('[DS778 S4] the queue never fails because the earlier-verdict lookup failed', () => {
  it('a failing lookup degrades every row to previousDecision: null and reports the failure', async () => {
    const { withPreviousDecisions } = await import('../modules/verification/previous-decision');
    const docs = [{ id: 'd1', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', createdAt: new Date('2026-10-06T12:00:00Z'), note: 'kept' }];
    const failures: unknown[] = [];
    const rows = await withPreviousDecisions(docs, async () => { throw new Error('connection reset'); }, (error) => failures.push(error));
    expect(rows).toEqual([{ ...docs[0], previousDecision: null }]);
    expect(failures).toHaveLength(1);
  });
  it('a working lookup attaches the decision, and an empty page reads nothing', async () => {
    const { withPreviousDecisions } = await import('../modules/verification/previous-decision');
    const docs = [{ id: 'd1', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', createdAt: new Date('2026-10-06T12:00:00Z') }];
    const rows = await withPreviousDecisions(docs, async () => [
      { id: 'old', userId: 'u1', role: 'CUSTOMER' as const, subjectId: null, docType: 'national_id', status: 'REJECTED', reviewNote: 'blurry', reviewedAt: null, createdAt: new Date('2026-10-01T00:00:00Z') },
    ], () => {});
    expect(rows[0]!.previousDecision).toMatchObject({ documentId: 'old', kind: 'RESUBMITTED_AFTER_REJECTION', reviewNote: 'blurry' });
    let read = false;
    expect(await withPreviousDecisions([], async () => { read = true; return []; }, () => {})).toEqual([]);
    expect(read).toBe(false);
  });
});
