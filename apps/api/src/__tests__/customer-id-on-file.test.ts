import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider, SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { customerIdCheck, ON_FILE_REVIEWER } from '../modules/verification/customer-id';
import { assertL2 } from '../modules/rides/rides.service';
import { FloatService } from '../modules/dispatch/float.service';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';
import { ownedVerificationFixture } from './helpers/verification-object';

// ---------------------------------------------------------------------------
// [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID]
//  (1) a customer's ID upload unlocks L2 RIGHT AWAY — no admin approval — unless an automatic
//      check flags it; then it is held for a person. An admin can withdraw it (back to L1) at
//      any time. Partner, driver and rider document review is UNCHANGED.
//  (2) a profile photo is a taxi-only requirement; no face match; never for food/shop.
// The words stay truthful: an ID that is only on file is never called "verified".
// These run on the launch engine (KYC_PROVIDER=manual: nothing is read automatically).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
let adminId: string;
const ids: string[] = [];
const clusters: string[] = [];
const runBase = 592_043_000_000 + Math.floor(Math.random() * 8_000_000);
let seq = 0;

/** A JPEG whose frame header says width × height; `salt` makes every file's bytes (and hash) unique. */
function jpeg(width: number, height: number, salt = nanoid(12)): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const note = Buffer.from(`swift-customer-id-${salt}`);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, note.length + 2]), note]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, com, sof0, Buffer.from([0xff, 0xd9])]);
}
const readable = () => jpeg(1600, 1000);
/** #1534 makes a reviewer type the number to approve a customer ID; main ignores the field. */
const typedNumber = () => `SYN${nanoid(8).replace(/[^A-Za-z0-9]/g, '7')}`;

async function customer(extra: Record<string, unknown> = {}) {
  const user = await runWithoutTenant(() => app.prisma.user.create({ data: {
    phone: `+${runBase + seq++}`, firstName: 'Synthetic', lastName: 'Customer',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, countryCode: 'GY', trustLevel: 'L1', ...extra,
  } }));
  ids.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: 'customer-id-test', deviceType: 'test',
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  } });
  return { id: user.id, token };
}

async function upload(token: string, bytes: Buffer, type = 'image/jpeg'): Promise<string> {
  const boundary = `----swift${nanoid(8)}`;
  const res = await app.inject({
    method: 'POST', url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="id"\r\ncontent-type: ${type}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.url as string;
}

function submit(token: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/v1/verification/identity',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { consent: true, privacyNoticeVersion: 'v1', ...body },
  });
}

function admin(method: 'PUT' | 'GET', url: string, payload?: Record<string, unknown>) {
  return injectWithApproval(app, {
    method, url, ...(payload ? { payload } : {}),
    headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
}

const user = (id: string) => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { trustLevel: true } });
const openCases = (docId: string) => app.prisma.reviewCase.count({ where: { submissionId: docId, closedAt: null } });
const audit = (docId: string) => app.prisma.auditLog.findMany({ where: { entityId: docId }, select: { action: true, changes: true } });
const notices = (userId: string) => app.prisma.notification.findMany({ where: { userId }, select: { title: true, body: true } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  vi.stubEnv('KYC_PROVIDER', 'manual');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const adminUser = await runWithoutTenant(() => app.prisma.user.create({ data: {
    phone: `+${runBase + 7_999_000}`, firstName: 'Synthetic', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN',
    isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } },
  } }));
  adminId = adminUser.id;
  ids.push(adminId);
  adminToken = app.jwt.sign({ userId: adminId, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    authMethod: 'OTP', userId: adminId, token: adminToken, refreshToken: nanoid(48), deviceId: 'customer-id-admin', deviceType: 'test',
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  } });
});

afterEach(() => { vi.stubEnv('KYC_PROVIDER', 'manual'); });

afterAll(async () => {
  vi.unstubAllEnvs();
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  if (!app) return;
  await runWithoutTenant(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: ids } } });
    await app.prisma.strike.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: ids } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusters } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  await app.close();
});

describe('(1) a customer ID goes on file at once — no admin approval', () => {
  it('a clean, readable ID with no selfie unlocks L2 now, with no review case and truthful words', async () => {
    const c = await customer();
    const res = await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) });
    expect(res.statusCode, res.body).toBe(201);
    const doc = res.json().data;
    expect(doc).toMatchObject({ status: 'APPROVED', idCheck: 'ON_FILE', reviewedBy: ON_FILE_REVIEWER, role: 'CUSTOMER', docType: 'identity_l2' });
    expect(await user(c.id)).toEqual({ trustLevel: 'L2' });
    expect(await openCases(doc.id)).toBe(0);
    expect((await audit(doc.id)).map((a) => a.action)).toContain('CUSTOMER_ID_ON_FILE');
    const told = await notices(c.id);
    expect(told.map((n) => n.title)).toContain('Your ID is on file');
    for (const n of told) expect(`${n.title} ${n.body}`).not.toMatch(/verified/i);
    // Taxi rides also need the profile photo (rides.service SELFIE_REQUIRED): the notice never says
    // rides are unlocked by the ID alone, nor promises orders "of any size".
    const onFile = told.find((n) => n.title === 'Your ID is on file');
    expect(onFile?.body).toMatch(/Taxi rides also need your profile photo/);
    expect(onFile?.body).not.toMatch(/any size|Taxi rides and/);
    expect(await customerIdCheck(app.prisma, c.id, 'L2')).toBe('ON_FILE');
  });

  // Store builds 9 and 10 (iPhone 9.1, release 14a8cf3b) send exactly { idDocumentUrl, selfieUrl,
  // consent: true, privacyNoticeVersion: 'v1' } after POST /verification/upload; the build reads only
  // success. That payload must keep working (the build under review talks to staging).
  it('store builds 9 and 10 still send a selfie: their own selfie is accepted (never compared); someone else’s is refused', async () => {
    const c = await customer();
    const other = await customer();
    const foreign = await submit(c.token, { idDocumentUrl: await upload(c.token, readable()), selfieUrl: await upload(other.token, readable()) });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('VERIFICATION_OBJECT_UNAVAILABLE');
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });

    const res = await submit(c.token, { idDocumentUrl: await upload(c.token, readable()), selfieUrl: await upload(c.token, readable()) });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ status: 'APPROVED', idCheck: 'ON_FILE' });
  });

  it('a second ID on an account already on file is refused in plain words', async () => {
    const c = await customer();
    expect((await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).statusCode).toBe(201);
    const again = await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('Your ID is already on file.');
  });

  it('the taxi L2 gate opens on an ID on file, and its refusal speaks of "on file", not verification', () => {
    expect(() => assertL2({ id: 'u', tenantId: 't', countryCode: 'GY', trustLevel: 'L2', selfieCapturedAt: new Date() })).not.toThrow();
    let message = '';
    try { assertL2({ id: 'u', tenantId: 't', countryCode: 'GY', trustLevel: 'L1', selfieCapturedAt: new Date() }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/ID on file/);
    expect(message).not.toMatch(/verif/i);
  });
});

describe('(1) an automatic check holds the ID for a person', () => {
  async function expectHeld(c: { id: string; token: string }, body: Record<string, unknown>, reason: string) {
    const res = await submit(c.token, body);
    expect(res.statusCode, res.body).toBe(201);
    const doc = res.json().data;
    expect(doc).toMatchObject({ status: 'PENDING', idCheck: 'WAITING', reviewedBy: null, reviewNote: null });
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    expect(await openCases(doc.id)).toBe(1);
    const held = (await audit(doc.id)).find((a) => a.action === 'CUSTOMER_ID_HELD');
    expect(String((held?.changes as { reason?: string } | null)?.reason)).toContain(reason);
    expect(await customerIdCheck(app.prisma, c.id, 'L1')).toBe('WAITING');
    return doc as { id: string };
  }

  it('TOO_SMALL: a picture too small to read', async () => {
    const c = await customer();
    await expectHeld(c, { idDocumentUrl: await upload(c.token, jpeg(400, 300)) }, 'TOO_SMALL');
  });

  it('NOT_MEASURABLE: a PDF (nobody can tell automatically whether it is readable)', async () => {
    const c = await customer();
    await expectHeld(c, { idDocumentUrl: await upload(c.token, Buffer.from('%PDF-1.4\n% synthetic\n'), 'application/pdf') }, 'NOT_MEASURABLE');
  });

  it('DUPLICATE_IMAGE: the same picture is already on another account (second-review queue; nothing tells the customer why)', async () => {
    const bytes = readable();
    const first = await customer();
    expect((await submit(first.token, { idDocumentUrl: await upload(first.token, bytes) })).json().data.status).toBe('APPROVED');
    const second = await customer();
    const doc = await expectHeld(second, { idDocumentUrl: await upload(second.token, bytes) }, 'DUPLICATE_IMAGE');
    expect((await app.prisma.reviewCase.findFirstOrThrow({ where: { submissionId: doc.id } })).queue).toBe('SECOND_REVIEW');
  });

  it('OPEN_SUBMISSION: an earlier ID is still waiting for a person — a new upload cannot jump the queue', async () => {
    const c = await customer();
    await expectHeld(c, { idDocumentUrl: await upload(c.token, jpeg(300, 200)) }, 'TOO_SMALL');
    await expectHeld(c, { idDocumentUrl: await upload(c.token, readable()) }, 'OPEN_SUBMISSION');
  });

  it('PRIOR_HOLD: a held ID the customer erased while it waited cannot be stepped around by a new upload', async () => {
    const c = await customer();
    const held = await expectHeld(c, { idDocumentUrl: await upload(c.token, jpeg(300, 200)) }, 'TOO_SMALL');
    const erased = await app.inject({
      method: 'POST', url: '/api/v1/verification/dsar/documents/erase',
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, payload: { documentIds: [held.id] },
    });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().data[0]).toMatchObject({ documentId: held.id, outcome: 'DESTROYED' });
    await expectHeld(c, { idDocumentUrl: await upload(c.token, readable()) }, 'PRIOR_HOLD');
  });

  it('ACCOUNT_HOLD: an account under an integrity hold', async () => {
    const c = await customer();
    await app.prisma.enforcementAction.create({ data: { accountId: c.id, level: 'REVIEW_FIRST', reasonCode: 'VELOCITY_DEVICE', signalsFired: [] as never, decidedBy: 'SYSTEM' } });
    await expectHeld(c, { idDocumentUrl: await upload(c.token, readable()) }, 'ACCOUNT_HOLD');
  });

  it('STRIKES: an account restricted after repeated failed cash payments', async () => {
    const c = await customer();
    for (let i = 0; i < 3; i++) await app.prisma.strike.create({ data: { userId: c.id, reason: 'synthetic failed cash handover' } });
    await expectHeld(c, { idDocumentUrl: await upload(c.token, readable()) }, 'STRIKES');
  });

  it('LINKED_ACCOUNT: another account linked to the same person already sent an ID', async () => {
    const first = await customer();
    const second = await customer();
    await runWithoutTenant(async () => {
      const cluster = await app.prisma.identityCluster.create({ data: {} });
      clusters.push(cluster.id);
      await app.prisma.identityClusterMember.createMany({ data: [first.id, second.id].map((accountId) => ({ clusterId: cluster.id, accountId, linkedVia: [{ type: 'DEVICE', strength: 'HARD', matchedAccountId: accountId === first.id ? second.id : first.id, at: new Date().toISOString() }] })) });
    });
    expect((await submit(first.token, { idDocumentUrl: await upload(first.token, readable()) })).json().data.status).toBe('APPROVED');
    await expectHeld(second, { idDocumentUrl: await upload(second.token, readable()) }, 'LINKED_ACCOUNT');
  });

  it('PROCESSOR_REFERRED: an engine that reads documents and refers one to a person is not overruled', async () => {
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    const c = await customer();
    const doc = await service.submitIdentity(c.id, await upload(c.token, readable()), undefined, 'v1');
    expect(doc).toMatchObject({ status: 'PENDING', reviewedBy: null });
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    expect(String(((await audit(doc.id)).find((a) => a.action === 'CUSTOMER_ID_HELD')?.changes as { reason?: string } | null)?.reason)).toContain('PROCESSOR_REFERRED');
  });

  it('CHECKS_UNAVAILABLE: a document processor that does not answer is a hold, never an approval', async () => {
    const down = {
      engine: { name: 'manual-review', version: 'synthetic', external: false },
      verifyDocument: async () => { throw new Error('synthetic outage'); },
      verifyIdentity: async () => { throw new Error('synthetic outage'); },
      getStatus: async () => 'pending_manual' as const,
    };
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), down);
    const c = await customer();
    const doc = await service.submitIdentity(c.id, await upload(c.token, readable()), undefined, 'v1');
    expect(doc).toMatchObject({ status: 'PENDING', reviewedBy: null });
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    expect(String(((await audit(doc.id)).find((a) => a.action === 'CUSTOMER_ID_HELD')?.changes as { reason?: string } | null)?.reason)).toContain('CHECKS_UNAVAILABLE');
  });

  it('CHECKS_UNAVAILABLE: when the checks cannot run, the ID waits for a person — never on file by default', async () => {
    const c = await customer();
    const key = await upload(c.token, readable());
    const spy = vi.spyOn(app.prisma.strike, 'count').mockRejectedValueOnce(new Error('synthetic outage'));
    try {
      await expectHeld(c, { idDocumentUrl: key }, 'CHECKS_UNAVAILABLE');
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('a person decides a held ID: approval unlocks L2 and only then may the app say it was checked', async () => {
    const c = await customer();
    const doc = await expectHeld(c, { idDocumentUrl: await upload(c.token, jpeg(400, 300)) }, 'TOO_SMALL');
    const approved = await admin('PUT', `/api/v1/admin/verification/${doc.id}/approve`, { documentNumber: typedNumber() });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await user(c.id)).toEqual({ trustLevel: 'L2' });
    expect(await customerIdCheck(app.prisma, c.id, 'L2')).toBe('CHECKED');
    // The person-checked notice is truthful too: bigger orders, and taxi rides need the profile photo.
    const checked = (await notices(c.id)).find((n) => n.title === 'Identity verified');
    expect(checked?.body).toMatch(/A person on our team checked your ID/);
    expect(checked?.body).toMatch(/Taxi rides also need your profile photo/);
    expect(checked?.body).not.toMatch(/any size/);
  });
});

describe('(1) an admin can withdraw an ID at any time — back to L1', () => {
  it('revoking an ID on file returns the account (even an earned L3) to L1, tells the customer, and the next upload waits for a person', async () => {
    const c = await customer();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).json().data;
    await app.prisma.user.update({ where: { id: c.id }, data: { trustLevel: 'L3' } });
    const revoked = await admin('PUT', `/api/v1/admin/verification/${doc.id}/revoke`, { reason: 'Synthetic: the picture is not an ID' });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().data.accountTrustLevel).toBe('L1');
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    // ...and the taxi gate refuses again (the big-order gate keys on the same L1, orders.test).
    expect(() => assertL2({ id: c.id, tenantId: 't', countryCode: 'GY', trustLevel: 'L1', selfieCapturedAt: new Date() })).toThrow(/ID on file/);
    expect((await notices(c.id)).map((n) => n.title)).toContain('Your ID is no longer on file');
    expect(await customerIdCheck(app.prisma, c.id, 'L1')).toBe('NOT_ACCEPTED');

    const next = await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) });
    expect(next.json().data).toMatchObject({ status: 'PENDING', idCheck: 'WAITING' });
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
  });
});

describe('a withdrawal outlives the document (review S1, S3)', () => {
  const erase = (token: string, id: string) => app.inject({
    method: 'POST', url: '/api/v1/verification/dsar/documents/erase',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { documentIds: [id] },
  });
  const heldFor = async (docId: string) => String(((await audit(docId)).find((a) => a.action === 'CUSTOMER_ID_HELD')?.changes as { reason?: string } | null)?.reason);

  it('revoke, then the customer erases the withdrawn ID, then re-uploads (even the same picture): held, stays L1', async () => {
    const c = await customer();
    const bytes = readable();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, bytes) })).json().data;
    expect((await admin('PUT', `/api/v1/admin/verification/${doc.id}/revoke`, { reason: 'Synthetic: not an ID card' })).statusCode).toBe(200);
    expect((await erase(c.token, doc.id)).json().data[0]).toMatchObject({ outcome: 'DESTROYED' });
    const again = (await submit(c.token, { idDocumentUrl: await upload(c.token, bytes) })).json().data;
    expect(again).toMatchObject({ status: 'PENDING', idCheck: 'WAITING' });
    expect(await heldFor(again.id)).toContain('EARLIER_DECISION');
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
  });

  it('a held ID a person approved, then withdrew, then the customer erased: the next upload still waits', async () => {
    const c = await customer();
    const held = (await submit(c.token, { idDocumentUrl: await upload(c.token, jpeg(400, 300)) })).json().data;
    expect((await admin('PUT', `/api/v1/admin/verification/${held.id}/approve`, { documentNumber: typedNumber() })).statusCode).toBe(200);
    expect((await admin('PUT', `/api/v1/admin/verification/${held.id}/revoke`, { reason: 'Synthetic: withdrawn after review' })).statusCode).toBe(200);
    expect((await erase(c.token, held.id)).json().data[0]).toMatchObject({ outcome: 'DESTROYED' });
    const again = (await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).json().data;
    expect(again).toMatchObject({ status: 'PENDING' });
    expect(await heldFor(again.id)).toContain('EARLIER_DECISION');
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
  });

  it('a withdrawal that commits after the automatic checks read the facts still holds the upload (re-read under the lock)', async () => {
    const c = await customer();
    const bytes = readable();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, bytes) })).json().data;
    expect((await admin('PUT', `/api/v1/admin/verification/${doc.id}/revoke`, { reason: 'Synthetic: not an ID card' })).statusCode).toBe(200);
    expect((await erase(c.token, doc.id)).json().data[0]).toMatchObject({ outcome: 'DESTROYED' });
    // The facts read lands BEFORE the withdrawal committed: it sees no earlier decision.
    const stale = vi.spyOn(app.prisma.reviewDecision, 'count').mockResolvedValueOnce(0);
    try {
      const again = (await submit(c.token, { idDocumentUrl: await upload(c.token, bytes) })).json().data;
      expect(again).toMatchObject({ status: 'PENDING', idCheck: 'WAITING' });
      expect(await heldFor(again.id)).toContain('EARLIER_DECISION');
    } finally { stale.mockRestore(); }
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
  });

  it('the promotion never raises an account whose ID no longer stands (a withdrawal or erasure in between wins)', async () => {
    const c = await customer();
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    await (service as unknown as { promoteToL2: (u: string, b: 'ON_FILE') => Promise<void> }).promoteToL2(c.id, 'ON_FILE');
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    expect((await notices(c.id)).map((n) => n.title)).not.toContain('Your ID is on file');
  });

  it('two uploads at once: one goes on file, the other waits for a person', async () => {
    const c = await customer();
    const [a, b] = await Promise.all([upload(c.token, readable()), upload(c.token, readable())]);
    const results = await Promise.all([submit(c.token, { idDocumentUrl: a }), submit(c.token, { idDocumentUrl: b })]);
    // One goes on file. The other is held by the lock (OPEN_SUBMISSION) — or, if it arrived after the
    // first had already raised the account, refused as ALREADY_VERIFIED. Never two on file.
    const onFile = results.filter((r) => r.statusCode === 201 && r.json().data.status === 'APPROVED');
    expect(onFile, results.map((r) => r.body).join(' | ')).toHaveLength(1);
    const other = results.find((r) => r !== onFile[0])!;
    if (other.statusCode === 201) {
      expect(other.json().data.status).toBe('PENDING');
      expect(await heldFor(other.json().data.id)).toContain('OPEN_SUBMISSION');
    } else {
      expect(other.statusCode, other.body).toBe(409);
      expect(other.json().error.code).toBe('ALREADY_VERIFIED');
    }
    expect(await app.prisma.verificationDocument.count({ where: { userId: c.id, docType: 'identity_l2', state: 'COMMITTED' } })).toBe(1);
    expect(await user(c.id)).toEqual({ trustLevel: 'L2' });
  });

  it('a second ID replaces the first (one stands per person); withdrawing the standing one says L1', async () => {
    const c = await customer();
    const first = (await submit(c.token, { idDocumentUrl: await upload(c.token, jpeg(400, 300)) })).json().data;
    const second = (await submit(c.token, { idDocumentUrl: await upload(c.token, jpeg(420, 300)) })).json().data;
    // [#1620] The second copy, sent while the first still waited, replaced it before review: the first can no
    // longer be decided (DOCUMENT_REPLACED), and the newer one is the one approved. One stands per person.
    const stale = await admin('PUT', `/api/v1/admin/verification/${first.id}/approve`, { documentNumber: typedNumber() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('DOCUMENT_REPLACED');
    expect((await admin('PUT', `/api/v1/admin/verification/${second.id}/approve`, { documentNumber: typedNumber() })).statusCode).toBe(200);
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('SUPERSEDED');
    expect((await admin('PUT', `/api/v1/admin/verification/${first.id}/revoke`, { reason: 'Synthetic: replaced ID' })).statusCode).toBe(409);
    const last = await admin('PUT', `/api/v1/admin/verification/${second.id}/revoke`, { reason: 'Synthetic: withdrawn after review' });
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json().data.accountTrustLevel).toBe('L1');
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    expect((await notices(c.id)).map((n) => n.title)).toContain('Your ID is no longer on file');
  });

  it("the customer's own status shows a neutral line for a withdrawn ID, never the reviewer's reason", async () => {
    const c = await customer();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).json().data;
    await admin('PUT', `/api/v1/admin/verification/${doc.id}/revoke`, { reason: 'Synthetic staff-only reason text' });
    const status = await app.inject({ method: 'GET', url: '/api/v1/verification/status', headers: { authorization: `Bearer ${c.token}` } });
    const row = (status.json().data.documents as Array<{ id: string; reviewNote: string | null }>).find((d) => d.id === doc.id);
    expect(row?.reviewNote).toBe('Withdrawn by our team');
    expect(status.body).not.toContain('Synthetic staff-only reason text');
    // The data-access export names the decision by a neutral category (WITHDRAWN), never the reason.
    const dsar = await app.inject({ method: 'GET', url: '/api/v1/verification/dsar/documents', headers: { authorization: `Bearer ${c.token}` } });
    expect(dsar.statusCode, dsar.body).toBe(200);
    const exported = (dsar.json().data.documents as Array<{ id: string; decisions: Array<{ outcome: string; category: string }> }>).find((d) => d.id === doc.id);
    expect(exported?.decisions).toEqual([expect.objectContaining({ outcome: 'REJECT', category: 'WITHDRAWN' })]);
    expect(dsar.body).not.toContain('Synthetic staff-only reason text');
  });

  it("a withdrawn ID the customer then erased (PURGED) still shows the neutral line, never the reviewer's reason", async () => {
    const c = await customer();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).json().data;
    expect((await admin('PUT', `/api/v1/admin/verification/${doc.id}/revoke`, { reason: 'Synthetic staff-only reason after erasure' })).statusCode).toBe(200);
    expect((await erase(c.token, doc.id)).json().data[0]).toMatchObject({ outcome: 'DESTROYED' });
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).state).toBe('PURGED');
    const status = await app.inject({ method: 'GET', url: '/api/v1/verification/status', headers: { authorization: `Bearer ${c.token}` } });
    expect(status.statusCode, status.body).toBe(200);
    const row = (status.json().data.documents as Array<{ id: string; reviewNote: string | null }>).find((d) => d.id === doc.id);
    if (row) expect(row.reviewNote).toBe('Withdrawn by our team');
    expect(status.body).not.toContain('Synthetic staff-only reason after erasure');
    expect(status.body).not.toContain('REVOKED:');
    // The data-access export stays truthful: the decision by its neutral category, never the words.
    const dsar = await app.inject({ method: 'GET', url: '/api/v1/verification/dsar/documents', headers: { authorization: `Bearer ${c.token}` } });
    const exported = (dsar.json().data.documents as Array<{ id: string; decisions: Array<{ outcome: string; category: string }> }>).find((d) => d.id === doc.id);
    expect(exported?.decisions).toEqual([expect.objectContaining({ outcome: 'REJECT', category: 'WITHDRAWN' })]);
    expect(dsar.body).not.toContain('Synthetic staff-only reason after erasure');
  });

  it('an account above L1 with no customer ID on record is not said to have one on file', async () => {
    const c = await customer({ trustLevel: 'L2' });
    expect(await customerIdCheck(app.prisma, c.id, 'L2')).toBe('NONE');
  });
});

describe('L2 stands on an ID on file', () => {
  it("the customer erasing their own ID on file takes the account back to L1, in the purge's transaction", async () => {
    const c = await customer();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).json().data;
    expect(await user(c.id)).toEqual({ trustLevel: 'L2' });
    const erased = await app.inject({
      method: 'POST', url: '/api/v1/verification/dsar/documents/erase',
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, payload: { documentIds: [doc.id] },
    });
    expect(erased.json().data[0]).toMatchObject({ documentId: doc.id, outcome: 'DESTROYED' });
    expect(await user(c.id)).toEqual({ trustLevel: 'L1' });
    expect(await customerIdCheck(app.prisma, c.id, 'L1')).toBe('NONE');
  });
});

describe('partner, driver and rider review is UNCHANGED', () => {
  it('a mover national ID under the launch engine still waits for a person', async () => {
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    const mover = await runWithoutTenant(() => app.prisma.user.create({ data: {
      phone: `+${runBase + seq++}`, firstName: 'Synthetic', lastName: 'Mover', roles: ['MOVER'], activeRole: 'MOVER',
      isPhoneVerified: true, countryCode: 'GY', trustLevel: 'L1', selfieCapturedAt: new Date(),
      rider: { create: { riderType: 'DELIVERY', vehicleType: 'BICYCLE' } },
    } }));
    ids.push(mover.id);
    const doc = await runWithoutTenant(async () => service.submitDocument(mover.id, 'MOVER', 'national_id', await ownedVerificationFixture(app.prisma, mover.id), 'v1'));
    expect(doc).toMatchObject({ status: 'PENDING', reviewedBy: null });
    expect(await openCases(doc.id)).toBe(1);
  });

  it("an ID that is only on file never lifts a rider's cash float; a person-approved one still does", async () => {
    const cfg = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { floatL1: true, floatL2: true } });
    expect(Number(cfg.floatL2)).toBeGreaterThan(Number(cfg.floatL1));
    const onFile = await customer();
    await app.prisma.rider.create({ data: { userId: onFile.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } });
    expect((await submit(onFile.token, { idDocumentUrl: await upload(onFile.token, readable()) })).json().data.status).toBe('APPROVED');
    await new FloatService(app.prisma).recomputeForUser(onFile.id);
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { userId: onFile.id } })).floatLimit)).toBe(Number(cfg.floatL1));

    const checked = await customer();
    await app.prisma.rider.create({ data: { userId: checked.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } });
    const held = (await submit(checked.token, { idDocumentUrl: await upload(checked.token, jpeg(400, 300)) })).json().data;
    expect((await admin('PUT', `/api/v1/admin/verification/${held.id}/approve`, { documentNumber: typedNumber() })).statusCode).toBe(200);
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { userId: checked.id } })).floatLimit)).toBe(Number(cfg.floatL2));
  });
});
