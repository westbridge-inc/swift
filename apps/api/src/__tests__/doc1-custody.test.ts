/**
 * [DOC-1 §20.2 · §20.3 · P20-2] The per-document chain of custody, as one read model.
 *
 * A real submission runs through the service (extraction ledger, validators, review case),
 * a reviewer approves it under a reason code with a private note, and a deletion receipt
 * records the destruction. The narrative then says everything §20.3 calls provable — and
 * never a field value, never the reviewer's note. The admin route returns it as JSON and as
 * the exportable PDF.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { custodyNarrative, renderCustodyPdf } from '../modules/verification/custody';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const TYPE = 'food_handler_cert';
const CODE = registryCode('GY', TYPE);
const KEK = crypto.randomBytes(32).toString('base64');
const prevKek = process.env['MASTER_KEK'];
const SECRET = `FH-${RUN}-SECRETVALUE`;
const NOTE = `private impression ${RUN}: looked genuine to me`;
const REASON = `Custody review ${RUN}`;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-custody-test');
let app: FastifyInstance;
let service: VerificationService;
let ownerId = '', adminId = '', adminToken = '', docId = '';
const users: string[] = [];
class SpyKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'spy', version: 'custody-1', external: false };
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `spy_${nanoid(6)}`, extracted: { documentNumber: SECRET } }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `spy_${nanoid(6)}`, extracted: { documentNumber: SECRET } }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = KEK;
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SpyKyc());
  await system(() => seedDocRegistry(app.prisma));
  await system(async () => {
    await app.prisma.docField.deleteMany({ where: { docTypeCode: CODE, fieldCode: 'doc_number' } });
    await app.prisma.docField.create({ data: { docTypeCode: CODE, fieldCode: 'doc_number', dataType: 'text', isRequired: true, isPii: true, isBlindIndexed: true, displayOrder: 1 } });
  });
  const o = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59273${NUM}1`, firstName: 'Cust', lastName: `Ody${RUN}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, avatar: `avatars/${RUN}/o.jpg`, selfieCapturedAt: new Date() } as never }));
  ownerId = o.id; users.push(o.id);
  const a = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59273${NUM}2`, firstName: 'Cust', lastName: `Admin${RUN}`, roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } as never }));
  adminId = a.id; users.push(a.id);
  adminToken = app.jwt.sign({ userId: adminId, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: adminId, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `cust-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } as never });
});
afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: ownerId }, select: { id: true } });
    const ids = docs.map((d) => d.id);
    // deletion_receipt is append-only [DOC-INV-7]: the receipt outlives the fixture, as evidence should
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: ids } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: ownerId } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.docField.deleteMany({ where: { docTypeCode: CODE, fieldCode: 'doc_number' } });
  });
  if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek;
  resetKeyProviderForTests();
  await app.close();
});

describe('[DOC-1 P20-2] the custody narrative', () => {
  it('a submission, its extraction, its verdicts, the decision under a reason code, the durable record and the destruction receipt — one ordered narrative; never a value, never the note', async () => {
    const doc = await runWithTenant('swift-default', () => service.submitDocument(ownerId, 'RESTAURANT', TYPE, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
    docId = doc.id;
    expect(doc.status).toBe('PENDING');
    await runWithTenant('swift-default', () => service.approveDocument(doc.id, adminId, new Date(Date.now() + 200 * 86_400_000)));
    await system(() => app.prisma.reviewDecision.updateMany({ where: { case: { submissionId: doc.id } }, data: { internalNote: NOTE } }));
    await system(() => app.prisma.deletionReceipt.create({ data: {
      submissionId: doc.id, subjectId: ownerId, docTypeCode: CODE, contentSha256: crypto.createHash('sha256').update(RUN).digest(), bytesDeleted: BigInt(40_960), deletedAt: new Date(),
      deletedBy: 'image-policy', storeLocations: ['storage:verification/x', 'encrypted_object:verification/x'], verificationProbeResult: 'CONFIRMED_ABSENT',
    } as never }));

    const n = await system(() => custodyNarrative(app.prisma, doc.id));
    expect(n.submission).toMatchObject({ id: doc.id, docType: TYPE, accountId: ownerId, status: 'APPROVED' });
    expect(n.extraction).toHaveLength(1);
    expect(n.extraction[0]).toMatchObject({ engine: 'spy', engineVersion: 'custody-1', ranExternally: false });
    expect(n.extraction[0]!.fields.map((f) => `${f.code}:${f.present}`)).toContain('doc_number:true');
    expect(n.extraction[0]!.fields.filter((f) => f.code !== 'doc_number').every((f) => !f.present)).toBe(true); // the type's other declared fields: absent, never a value
    expect(n.validations.map((v) => v.code)).toEqual(expect.arrayContaining(['V_ALL_REQUIRED_PRESENT', 'V_SHA_COLLISION']));
    expect(n.review).toHaveLength(1);
    expect(n.review[0]!.decisions.at(-1)).toMatchObject({ reviewerId: adminId, outcome: 'APPROVE' });
    expect(n.record).toMatchObject({ status: 'VALID', approvedBy: adminId });
    expect(n.destruction).toEqual([expect.objectContaining({ by: 'image-policy', probe: 'CONFIRMED_ABSENT', bytesDeleted: 40_960, stores: ['storage:verification/x', 'encrypted_object:verification/x'] })]);
    const whats = n.timeline.map((e) => e.what);
    // Extraction runs BEFORE the row is created (ledger first), so the submission is not necessarily the first line — it is present, and the timeline is time-ordered.
    expect(whats.some((w) => /^SUBMITTED food_handler_cert/.test(w))).toBe(true);
    expect(whats.some((w) => w.startsWith('EXTRACTED'))).toBe(true);
    expect(whats.some((w) => w.startsWith('DECIDED APPROVE'))).toBe(true);
    expect(whats.some((w) => w.startsWith('RECORD VALID'))).toBe(true);
    expect(whats.some((w) => w.startsWith('DESTROYED') && w.includes('CONFIRMED_ABSENT'))).toBe(true);
    for (let i = 1; i < n.timeline.length; i += 1) expect(n.timeline[i]!.at >= n.timeline[i - 1]!.at).toBe(true);
    expect(n.provable[0]).toContain(`type ${TYPE}`);
    expect(n.provable[0]).toContain(`account ${ownerId}`);
    expect(n.provable.some((p) => p.includes('destroyed') && p.includes('CONFIRMED_ABSENT'))).toBe(true);
    expect(n.notProvable).toHaveLength(4);
    // §20.3: a value is never in the record; the reviewer's private impression is not part of it.
    const text = JSON.stringify(n);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain('internalNote');
  });

  it('the admin route returns the narrative as JSON and as an exportable PDF, and refuses an unknown submission', async () => {
    const json = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/${docId}/custody`, headers: { authorization: `Bearer ${adminToken}`, 'x-swift-reason': REASON } });
    expect(json.statusCode, json.body).toBe(200);
    expect(json.json().data.submission.id).toBe(docId);
    expect(json.body).not.toContain(SECRET);
    const pdf = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/${docId}/custody?format=pdf`, headers: { authorization: `Bearer ${adminToken}`, 'x-swift-reason': REASON } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const rendered = await renderCustodyPdf(await system(() => custodyNarrative(app.prisma, docId)));
    expect(rendered.length).toBeGreaterThan(1000);
    const missing = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/nope-${RUN}/custody`, headers: { authorization: `Bearer ${adminToken}`, 'x-swift-reason': REASON } });
    expect(missing.statusCode).toBe(404);
  });
});
