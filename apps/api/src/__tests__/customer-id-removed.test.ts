/**
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 17:31Z (b) · Q1-Q3 the same day] The customer ID is REMOVED, fully.
 * Supersedes the 8 Oct ruling (a customer ID on file at once) and what the 24 Oct ruling kept of it (the high-value
 * promo gate and the strike-restriction lift).
 *
 *  - POST /verification/identity answers 410 CUSTOMER_ID_NOT_NEEDED in polite words and records nothing. Store builds
 *    9-12 upload the picture before asking: the refusal erases that upload at once (only the caller's own, unclaimed,
 *    unheld one), and the selfie builds 9-10 send beside it.
 *  - The stored customer IDs are retired by the daily sweep: withdrawn under the person's lock (on file -> REVOKED,
 *    waiting -> EXPIRED with its review case closed), the account back to L1 (Q3), then deleted through the one purge
 *    path (shred, delete, probe, receipt). A legal hold keeps the bytes until it ends; the withdrawal still happens.
 *  - A reviewer cannot approve a customer ID any more.
 *  - Q1: a strike restriction applies at every level and is lifted by time (90 days) or by a person at Swift (an
 *    audited admin action); a lift never lifts a ban, and strikes after it restrict again.
 *  - Q2: L3 is earned from L1 directly (trust-tiers.test.ts); L2 is retired, so an account still marked L2 fronts no
 *    more cash than L1.
 *  - The profile no longer says anything about an ID; the Terms and the Privacy Policy say Swift takes none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { VerificationService, CUSTOMER_ID_RETIRED_ACTOR } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { FloatService, floatTrustLevel } from '../modules/dispatch/float.service';
import { orderingRestriction } from '../modules/cash/cash-rules.service';
import { LEGAL_VERSION, PRIVACY, TERMS } from '../modules/legal/legal.routes';
import { NON_MATERIAL_CHANGES, MATERIAL_CHANGES } from '../modules/legal/reaccept';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { jpegSized } from './helpers/real-image';

let app: FastifyInstance;
let service: VerificationService;
let adminToken = '';
const ids: string[] = [];
const runBase = 592_047_000_000 + Math.floor(Math.random() * 8_000_000);
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'customer-id-removed-test');
const readable = () => jpegSized(1600, 1000, `swift-customer-id-removed-${nanoid(12)}`);

async function person(extra: Record<string, unknown> = {}) {
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+${runBase + seq++}`, firstName: 'Synthetic', lastName: 'Customer',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, countryCode: 'GY', trustLevel: 'L1', ...extra,
  } }));
  ids.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: 'customer-id-removed', deviceType: 'test', expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  } }));
  return { id: user.id, token };
}

async function upload(token: string, bytes: Buffer): Promise<string> {
  const boundary = `----swift${nanoid(8)}`;
  const res = await app.inject({
    method: 'POST', url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="id"\r\ncontent-type: image/jpeg\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.url as string;
}

const identity = (token: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/v1/verification/identity',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload,
});
const admin = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown> = {}) => app.inject({
  method, url, payload, headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
});
const envelope = (fileKey: string) => system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey } }));
const receipts = (subjectId: string, docTypeCode: string) => system(() => app.prisma.deletionReceipt.count({ where: { subjectId, docTypeCode } }));
const trust = async (id: string) => (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { trustLevel: true } }))).trustLevel;

/** A customer ID stored before the ruling, on the real upload: ON FILE (approved, committed) or WAITING (its case open). */
async function storedId(c: { id: string; token: string }, kind: 'ON_FILE' | 'WAITING') {
  const fileUrl = await upload(c.token, readable());
  const tenantId = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: c.id }, select: { tenantId: true } }))).tenantId;
  const doc = await system(() => app.prisma.verificationDocument.create({ data: {
    userId: c.id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl, consentAt: new Date(), privacyNoticeVersion: '2026-10-29.2',
    ...(kind === 'ON_FILE' ? { status: 'APPROVED' as const, reviewedBy: 'fixture-reviewer', reviewedAt: new Date() } : { status: 'PENDING' as const }),
  } }));
  const kase = kind === 'WAITING'
    ? await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, tenantId, queue: 'STANDARD', slaDueAt: new Date(Date.now() + 86_400_000) } }))
    : null;
  if (kind === 'ON_FILE') await system(() => app.prisma.user.update({ where: { id: c.id }, data: { trustLevel: 'L2' } }));
  return { docId: doc.id, fileUrl, caseId: kase?.id ?? null };
}

beforeAll(async () => {
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  vi.stubEnv('KYC_PROVIDER', 'manual');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const a = await system(() => app.prisma.user.create({ data: {
    phone: `+${runBase + 7_999_000}`, firstName: 'Synthetic', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN',
    isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*', 'documents.review'] } },
  } }));
  ids.push(a.id);
  adminToken = app.jwt.sign({ userId: a.id, role: 'ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    authMethod: 'OTP', userId: a.id, token: adminToken, refreshToken: nanoid(48), deviceId: 'customer-id-removed-admin', deviceType: 'test', expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  } }));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.strike.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: ids } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  await app.close();
});

describe('[CHECKLIST-LEGAL (b)] POST /verification/identity: not needed any more', () => {
  it('store build 12\'s exact call is answered 410 in polite words, records nothing, and its upload is erased now', async () => {
    const c = await person();
    const idDocumentUrl = await upload(c.token, readable());
    const res = await identity(c.token, { idDocumentUrl, consent: true, privacyNoticeVersion: '2026-10-29.2', consentTick: 'customer_id_v1' });
    expect(res.statusCode, res.body).toBe(410);
    const error = res.json().error;
    expect(error.code).toBe('CUSTOMER_ID_NOT_NEEDED');
    expect(error.message).toMatch(/no longer asks for your ID/);
    expect(error.message).toMatch(/has not been kept/);
    await system(async () => {
      expect(await app.prisma.verificationDocument.count({ where: { userId: c.id } })).toBe(0);
      expect(await app.prisma.consentRecord.count({ where: { subjectId: c.id } })).toBe(0);
    });
    const e = await envelope(idDocumentUrl);
    expect([e.wrappedDek, e.shreddedAt instanceof Date]).toEqual([null, true]);
    expect(await receipts(c.id, 'unused_customer_id')).toBe(1);
    expect(await trust(c.id)).toBe('L1');
  });

  it('store builds 9 and 10 send a selfie beside it: both of the caller\'s own uploads are erased', async () => {
    const c = await person();
    const idDocumentUrl = await upload(c.token, readable());
    const selfieUrl = await upload(c.token, readable());
    expect((await identity(c.token, { idDocumentUrl, selfieUrl, consent: true, privacyNoticeVersion: 'v1' })).statusCode).toBe(410);
    expect((await envelope(idDocumentUrl)).shreddedAt).toBeInstanceOf(Date);
    expect((await envelope(selfieUrl)).shreddedAt).toBeInstanceOf(Date);
    expect(await receipts(c.id, 'unused_customer_id')).toBe(1);
    expect(await receipts(c.id, 'unused_customer_selfie')).toBe(1);
  });

  it('never erases what is not the caller\'s own, unclaimed, unheld upload; the answer is the same', async () => {
    const c = await person();
    const other = await person();
    const foreign = await upload(other.token, readable());
    // the caller's own upload that a document already names
    const claimed = await upload(c.token, readable());
    await system(() => app.prisma.verificationDocument.create({ data: { userId: c.id, role: 'MOVER', docType: 'drivers_licence', fileUrl: claimed, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } }));
    for (const idDocumentUrl of [foreign, claimed]) {
      expect((await identity(c.token, { idDocumentUrl, consent: true, privacyNoticeVersion: 'v1' })).statusCode).toBe(410);
      const e = await envelope(idDocumentUrl);
      expect([e.wrappedDek === null, e.shreddedAt]).toEqual([false, null]);
    }
    // under a legal hold nothing of the person's is erased
    const held = await person();
    const heldUpload = await upload(held.token, readable());
    await system(() => app.prisma.docLegalHold.create({ data: { subjectUserId: held.id, reason: `customer-id-removed-test ${nanoid(4)}`, ownerId: 'test', placedBy: 'test', reviewBy: new Date(Date.now() + 30 * 86_400_000) } }));
    expect((await identity(held.token, { idDocumentUrl: heldUpload, consent: true, privacyNoticeVersion: 'v1' })).statusCode).toBe(410);
    expect((await envelope(heldUpload)).shreddedAt).toBeNull();
    // an empty or malformed body gets the same polite answer, never a validation error first
    for (const payload of [{}, { idDocumentUrl: 7 }, { idDocumentUrl: 'x'.repeat(5000) }]) {
      const res = await identity(c.token, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(410);
      expect(res.json().error.code).toBe('CUSTOMER_ID_NOT_NEEDED');
    }
  });

  it('the profile says nothing about an ID any more', async () => {
    const c = await person();
    const res = await app.inject({ method: 'GET', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${c.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).not.toHaveProperty('idCheck');
  });
});

describe('[CHECKLIST-LEGAL (b)] the stored customer IDs are withdrawn and deleted', () => {
  it('an ID on file and one waiting are withdrawn (account back to L1, case closed), then deleted with a receipt; a held one keeps its bytes', async () => {
    const onFile = await person();
    const a = await storedId(onFile, 'ON_FILE');
    const waiting = await person();
    const b = await storedId(waiting, 'WAITING');
    const earned = await person();
    const e = await storedId(earned, 'ON_FILE');
    await system(() => app.prisma.user.update({ where: { id: earned.id }, data: { trustLevel: 'L3' } }));
    const heldPerson = await person();
    const h = await storedId(heldPerson, 'ON_FILE');
    const hold = await system(() => app.prisma.docLegalHold.create({ data: { subjectUserId: heldPerson.id, reason: `customer-id-removed-test ${nanoid(4)}`, ownerId: 'test', placedBy: 'test', reviewBy: new Date(Date.now() + 30 * 86_400_000) } }));
    await system(() => app.prisma.verificationDocument.update({ where: { id: h.docId }, data: { legalHoldId: hold.id } }));

    const first = await system(() => service.retireCustomerIds());
    expect(first.withdrawn).toBeGreaterThanOrEqual(4);
    expect(first.held).toBeGreaterThanOrEqual(1);

    const row = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { state: true, status: true, purgedAt: true, fileUrl: true, reviewNote: true, legalHoldId: true } }));
    for (const [doc, who] of [[a, onFile], [b, waiting], [e, earned]] as const) {
      const r = await row(doc.docId);
      expect(r.purgedAt, who.id).toBeInstanceOf(Date);
      expect(r.fileUrl).toBe('');
      expect((await envelope(doc.fileUrl)).shreddedAt).toBeInstanceOf(Date);
      expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: doc.docId, deletedBy: CUSTOMER_ID_RETIRED_ACTOR } }))).toBe(1);
      expect(await trust(who.id)).toBe('L1'); // Q3: an earned L3 that stood on the ID too
    }
    // the waiting one is out of every queue: its case is closed and it is no longer PENDING
    expect(await system(() => app.prisma.reviewCase.count({ where: { submissionId: b.docId, closedAt: null } }))).toBe(0);
    expect((await row(b.docId)).status).not.toBe('PENDING');
    // the held one is withdrawn (it confers nothing) but keeps its bytes until the hold ends
    const held = await row(h.docId);
    expect(held).toMatchObject({ purgedAt: null, legalHoldId: hold.id, status: 'REJECTED' });
    expect(held.fileUrl).toBe(h.fileUrl);
    expect(held.reviewNote).toMatch(/no longer keeps customer IDs/);
    expect((await envelope(h.fileUrl)).shreddedAt).toBeNull();
    expect(await trust(heldPerson.id)).toBe('L1');

    // a second run changes nothing; once the hold ends, the next run deletes it
    const again = await system(() => service.retireCustomerIds());
    expect(again.withdrawn).toBe(0);
    expect((await row(h.docId)).purgedAt).toBeNull();
    await system(() => app.prisma.verificationDocument.update({ where: { id: h.docId }, data: { legalHoldId: null } }));
    await system(() => app.prisma.docLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedBy: 'test', releaseReason: 'customer-id-removed-test' } }));
    await system(() => service.retireCustomerIds());
    expect((await row(h.docId)).purgedAt).toBeInstanceOf(Date);
    expect((await envelope(h.fileUrl)).shreddedAt).toBeInstanceOf(Date);
  });

  it('a reviewer can no longer approve a customer ID', async () => {
    const c = await person();
    const { docId } = await storedId(c, 'WAITING');
    const res = await admin('PUT', `/api/v1/admin/verification/${docId}/approve`, {});
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().error.code).toBe('CUSTOMER_ID_RETIRED');
    expect(await trust(c.id)).toBe('L1');
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId }, select: { status: true } }))).status).toBe('PENDING');
  });
});

describe('[CHECKLIST-LEGAL (b) · Q1] a strike restriction: time, or a person at Swift', () => {
  const strike = (userId: string, n: number) => system(async () => {
    for (let i = 0; i < n; i++) await app.prisma.strike.create({ data: { userId, reason: 'failed_payment_no_show', phone: 'x', addressKey: `geo:cir${i}` } });
  });

  it('applies at every trust level: an ID is no way out, and an earned L3 is not exempt', async () => {
    for (const trustLevel of ['L1', 'L2', 'L3'] as const) {
      const c = await person({ trustLevel });
      await strike(c.id, 2);
      expect(await system(() => orderingRestriction(app.prisma, c.id)), trustLevel).toBe('restricted');
    }
  });

  it('a person lifts it from Help: audited, the customer is told; strikes after the lift count again; a ban is never lifted', async () => {
    const c = await person();
    expect((await admin('POST', `/api/v1/admin/users/${c.id}/strike-restriction/lift`)).json().error.code).toBe('NOT_RESTRICTED');
    await strike(c.id, 2);
    const lift = await admin('POST', `/api/v1/admin/users/${c.id}/strike-restriction/lift`);
    expect(lift.statusCode, lift.body).toBe(200);
    expect(lift.json().data.restriction).toBeNull();
    expect(await system(() => orderingRestriction(app.prisma, c.id))).toBeNull();
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'STRIKE_RESTRICTION_LIFTED', entityId: c.id } }))).toBe(1);
    expect((await system(() => app.prisma.notification.findMany({ where: { userId: c.id }, select: { title: true } }))).map((n) => n.title)).toContain('Ordering is open again');
    // the lift counts the strikes before it out; two new ones restrict again
    await new Promise((r) => setTimeout(r, 5));
    await strike(c.id, 2);
    expect(await system(() => orderingRestriction(app.prisma, c.id))).toBe('banned'); // four in 90 days: the ban stands
    const banned = await admin('POST', `/api/v1/admin/users/${c.id}/strike-restriction/lift`);
    expect(banned.json().error.code).toBe('STRIKE_BANNED');
    const d = await person();
    await strike(d.id, 2);
    expect((await admin('POST', `/api/v1/admin/users/${d.id}/strike-restriction/lift`)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    await strike(d.id, 1);
    expect(await system(() => orderingRestriction(app.prisma, d.id))).toBeNull(); // one since the lift: open
    await strike(d.id, 1);
    // two since the lift would restrict again, but with the two before it that is four in 90 days: the ban, which no lift lifts
    expect(await system(() => orderingRestriction(app.prisma, d.id))).toBe('banned');
  });

  // [COORD security review] The same hands and authority as a suspension, a stated reason, and the target account only.
  it('a lift needs a stated reason, an actor who outranks the target and is not the target or linked to it', async () => {
    const lift = (target: string, token = adminToken, reason: string | null = TEST_ADMIN_REASON) => app.inject({
      method: 'POST', url: `/api/v1/admin/users/${target}/strike-restriction/lift`, payload: {},
      headers: { ...(reason === null ? {} : { 'x-swift-reason': reason }), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const lifts = (target: string) => system(() => app.prisma.auditLog.count({ where: { action: 'STRIKE_RESTRICTION_LIFTED', entityId: target } }));
    const c = await person();
    await strike(c.id, 2);
    // no reason: refused, nothing written
    expect((await lift(c.id, adminToken, null)).statusCode).toBe(400);
    expect(await lifts(c.id)).toBe(0);
    // a peer (another admin) is never lifted, nor the actor's own account
    const peer = await system(() => app.prisma.user.create({ data: {
      phone: `+${runBase + 7_999_100 + seq++}`, firstName: 'Synthetic', lastName: 'PeerAdmin', roles: ['ADMIN'], activeRole: 'ADMIN',
      isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } },
    } }));
    ids.push(peer.id);
    await strike(peer.id, 2);
    expect((await lift(peer.id)).statusCode).toBe(403);
    expect(await lifts(peer.id)).toBe(0);
    const self = (await system(() => app.prisma.session.findFirstOrThrow({ where: { token: adminToken }, select: { userId: true } }))).userId;
    expect((await lift(self)).statusCode).toBe(403);
    // an actor linked to the target's identity is refused
    const cluster = await system(() => app.prisma.identityCluster.create({ data: {} }));
    await system(() => app.prisma.identityClusterMember.createMany({ data: [
      { accountId: c.id, clusterId: cluster.id, linkedVia: [] }, { accountId: self, clusterId: cluster.id, linkedVia: [] },
    ] }));
    try {
      expect((await lift(c.id)).statusCode).toBe(403);
      expect(await lifts(c.id)).toBe(0);
    } finally {
      await system(() => app.prisma.identityClusterMember.deleteMany({ where: { clusterId: cluster.id } }));
      await system(() => app.prisma.identityCluster.delete({ where: { id: cluster.id } }));
    }
    expect((await lift(c.id)).statusCode).toBe(200);
    expect(await lifts(c.id)).toBe(1);
  });

  it('a lift opens the account it was given for, never a linked account', async () => {
    const a = await person();
    const b = await person();
    const cluster = await system(() => app.prisma.identityCluster.create({ data: {} }));
    await system(() => app.prisma.identityClusterMember.createMany({ data: [
      { accountId: a.id, clusterId: cluster.id, linkedVia: [] }, { accountId: b.id, clusterId: cluster.id, linkedVia: [] },
    ] }));
    try {
      await strike(a.id, 2); // the person's strikes restrict both accounts
      expect(await system(() => orderingRestriction(app.prisma, b.id))).toBe('restricted');
      expect((await admin('POST', `/api/v1/admin/users/${a.id}/strike-restriction/lift`)).statusCode).toBe(200);
      expect(await system(() => orderingRestriction(app.prisma, a.id))).toBeNull();
      expect(await system(() => orderingRestriction(app.prisma, b.id))).toBe('restricted');
    } finally {
      await system(() => app.prisma.identityClusterMember.deleteMany({ where: { clusterId: cluster.id } }));
      await system(() => app.prisma.identityCluster.delete({ where: { id: cluster.id } }));
    }
  });

  it('the words name the way out, never an ID', () => {
    for (const rel of ['modules/order/order.service.ts', 'modules/rides/rides.service.ts']) {
      const text = readFileSync(join(__dirname, '..', rel), 'utf8');
      const at = text.indexOf("'STRIKE_RESTRICTED'");
      const words = text.slice(at, at + 300);
      expect(words, rel).toMatch(/90 days old/);
      expect(words, rel).toMatch(/a person at Swift/);
      expect(words, rel).not.toMatch(/\bID\b/);
    }
  });
});

describe('[CHECKLIST-LEGAL (b) · Q2] L2 is retired', () => {
  it('an account still marked L2 fronts no more cash than L1', async () => {
    expect(floatTrustLevel('L2')).toBe('L1');
    expect(floatTrustLevel('L3')).toBe('L3');
    const c = await person({ trustLevel: 'L2', roles: ['CUSTOMER', 'RIDER'] });
    // a rider whose own partner documents a person approved: only the retired level could size the float
    await system(() => app.prisma.rider.create({ data: { userId: c.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } }));
    const licence = await system(() => app.prisma.verificationDocument.create({ data: {
      userId: c.id, role: 'MOVER', docType: 'drivers_licence', fileUrl: `verification/${c.id}/${nanoid(8)}.enc`, status: 'APPROVED', reviewedBy: 'fixture-reviewer', reviewedAt: new Date(),
      consentAt: new Date(), privacyNoticeVersion: 'v1',
    } }));
    const tenantId = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: c.id }, select: { tenantId: true } }))).tenantId;
    const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: licence.id, tenantId, queue: 'STANDARD', slaDueAt: new Date(), closedAt: new Date() } }));
    await system(() => app.prisma.reviewDecision.create({ data: { caseId: kase.id, tenantId, reviewerId: 'fixture-reviewer', outcome: 'APPROVE', reasonCode: 'APPROVED', actorFacingCategory: 'APPROVED', timeOnCaseMs: 0 } }));
    await system(() => new FloatService(app.prisma).recomputeForUser(c.id));
    const gy = await system(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { floatL1: true } }));
    const rider = await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: c.id }, select: { floatLimit: true } }));
    expect(Number(rider.floatLimit)).toBe(Number(gy.floatL1));
  });

  it('nothing raises an account to L2 and nothing asks for an ID any more (source census)', () => {
    const service = readFileSync(join(__dirname, '../modules/verification/verification.service.ts'), 'utf8');
    expect(service).not.toMatch(/async submitIdentity\(/);
    expect(service).not.toMatch(/trustLevel: 'L2'/);
    const order = readFileSync(join(__dirname, '../modules/order/order.service.ts'), 'utf8');
    expect(order).not.toMatch(/'ID_VERIFICATION_REQUIRED'/);
  });
});

describe('[CHECKLIST-LEGAL (b)] the legal words', () => {
  it('the Terms and the Privacy Policy say Swift takes no customer ID, under 2026-11-01.1, classed non-material', () => {
    expect(LEGAL_VERSION).toBe('2026-11-01.1');
    expect(TERMS).toContain('A customer never needs an ID or a photo to use Swift, and Swift does not ask a customer for either.');
    expect(TERMS).not.toMatch(/asks for a government-issued ID on file/);
    expect(PRIVACY).toContain('<li><b>Verification documents (partners only):</b>');
    expect(PRIVACY).toContain('Swift does not ask a customer for an ID and does not keep one.');
    expect(PRIVACY).toContain("Swift no longer keeps customers' IDs: any a customer added before 1 November 2026 is withdrawn and deleted, unless a legal or safety hold keeps it until the hold ends.");
    expect(PRIVACY).not.toMatch(/customer's ID goes on file|the ID a customer adds|A customer's own ID is not on that schedule/);
    expect(NON_MATERIAL_CHANGES.filter((c) => c.version === '2026-11-01.1')).toHaveLength(1);
    expect(MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-01.1');
  });
});
