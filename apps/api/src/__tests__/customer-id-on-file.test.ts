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
    expect(await customerIdCheck(app.prisma, c.id, 'L2')).toBe('ON_FILE');
  });

  it('store build 9 still sends a selfie: its own selfie is accepted (never compared); someone else’s is refused', async () => {
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
    const approved = await admin('PUT', `/api/v1/admin/verification/${doc.id}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await user(c.id)).toEqual({ trustLevel: 'L2' });
    expect(await customerIdCheck(app.prisma, c.id, 'L2')).toBe('CHECKED');
  });
});

describe('(1) an admin can withdraw an ID at any time — back to L1', () => {
  it('revoking an ID on file returns the account (even an earned L3) to L1, tells the customer, and the next upload waits for a person', async () => {
    const c = await customer();
    const doc = (await submit(c.token, { idDocumentUrl: await upload(c.token, readable()) })).json().data;
    await app.prisma.user.update({ where: { id: c.id }, data: { trustLevel: 'L3' } });
    const revoked = await admin('PUT', `/api/v1/admin/verification/${doc.id}/revoke`, { reason: 'Synthetic: the picture is not an ID' });
    expect(revoked.statusCode, revoked.body).toBe(200);
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
    expect((await admin('PUT', `/api/v1/admin/verification/${held.id}/approve`, {})).statusCode).toBe(200);
    expect(Number((await app.prisma.rider.findUniqueOrThrow({ where: { userId: checked.id } })).floatLimit)).toBe(Number(cfg.floatL2));
  });
});
