/**
 * [DOC-1 Part XXV · P25] test_no_direct_document_record_mutation — DOC-INV-34,
 * and the three requests that will actually arrive.
 *
 * Export: the person's own documents, fields decrypted through the key
 * provider, decisions as categories only, receipts — never another person's
 * data; the read is audited with a reason code. Erase: destroyed → the
 * receipt is the answer; hold / AML class / an approved licence backing a
 * live relationship → refused with the ground; otherwise destroyed now with
 * the extracted values crypto-shredded. Rectify: re-opens a review case with
 * provenance and touches no record; the SLA watchdog leaves that case open.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { refusalGround } from '../modules/verification/dsar';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const TYPE = 'tin_certificate';
const CODE = registryCode('GY', TYPE);
const AML_TYPE = 'business_registration';
const AML_CODE = registryCode('GY', AML_TYPE);
const KEK = crypto.randomBytes(32).toString('base64');
const prevKek = process.env['MASTER_KEK'];
const API_SRC = join(__dirname, '..');

let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
const tokens = new Map<string, string>();
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-dsar-test');

class SpyKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'spy', version: 'test', external: false };
  extracted: Record<string, unknown> | undefined;
  private result(): KycVerificationResult { return { status: 'pending_manual', referenceToken: `spy_${nanoid(6)}`, extracted: this.extracted as KycVerificationResult['extracted'] }; }
  async verifyIdentity(): Promise<KycVerificationResult> { return this.result(); }
  async verifyDocument(): Promise<KycVerificationResult> { return this.result(); }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}
const kyc = new SpyKyc();

async function person(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59277${NUM}${n}`, firstName: 'Data', lastName: `Subject${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `dsar-${RUN}-${n}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  tokens.set(u.id, token);
  return u.id;
}
const submit = (userId: string, docType: string, documentNumber?: string) => {
  kyc.extracted = documentNumber ? { documentNumber } : undefined;
  return runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', docType, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
};
const get = (userId: string) => app.inject({ method: 'GET', url: '/api/v1/verification/dsar/documents', headers: { authorization: `Bearer ${tokens.get(userId)}` } });
const erase = (userId: string, documentIds?: string[]) => app.inject({ method: 'POST', url: '/api/v1/verification/dsar/documents/erase', payload: documentIds ? { documentIds } : {}, headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' } });
const rectify = (userId: string, documentId: string, fieldCode: string) => app.inject({ method: 'POST', url: '/api/v1/verification/dsar/documents/rectify', payload: { documentId, fieldCode, note: `The number reads 12 not 17 (${RUN})` }, headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' } });
const docRow = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, include: { extractionRuns: { include: { fields: true } } } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = KEK;
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
  await system(async () => {
    await seedDocRegistry(app.prisma);
    await app.prisma.docField.deleteMany({ where: { docTypeCode: CODE, fieldCode: 'doc_number' } });
    await app.prisma.docField.create({ data: { docTypeCode: CODE, fieldCode: 'doc_number', dataType: 'text', isRequired: true, isPii: true, isBlindIndexed: true, displayOrder: 1 } });
    await app.prisma.docType.update({ where: { code: AML_CODE }, data: { amlRecordClass: 'CDD_ENTITY' } });
  });
  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59277${NUM}9`, firstName: 'Dsar', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } }));
  adminId = admin.id; users.push(adminId);
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.docType.update({ where: { code: AML_CODE }, data: { amlRecordClass: 'NOT_APPLICABLE' } });
    await app.prisma.docField.deleteMany({ where: { docTypeCode: CODE, fieldCode: 'doc_number' } });
    await app.prisma.rectificationRequest.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
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

describe('[DOC-1 P25] data-subject rights against documents', () => {
  let me = ''; let other = '';
  let mine = ''; let theirs = '';
  const NUMBER = `TIN ${RUN}-4471`;

  it('export: my documents with my decrypted fields, decisions as categories only, receipts — never another person’s; the read is audited with a reason code', async () => {
    me = await person(1); other = await person(2);
    mine = (await submit(me, TYPE, NUMBER)).id;
    theirs = (await submit(other, TYPE, `TIN ${RUN}-9999`)).id;
    await runWithTenant('swift-default', () => service.rejectDocument(mine, adminId, `internal-note-${RUN}`, 'UNREADABLE'));
    const res = await get(me);
    expect(res.statusCode).toBe(200);
    const { documents } = res.json().data;
    expect(documents.map((d: { id: string }) => d.id)).toEqual([mine]);
    const [d] = documents;
    expect(d.fields.find((f: { fieldCode: string }) => f.fieldCode === 'doc_number')).toMatchObject({ value: NUMBER, valueUnavailable: false });
    expect(d.decisions).toEqual([expect.objectContaining({ outcome: 'REJECT', category: 'QUALITY' })]);
    expect(JSON.stringify(res.json())).not.toContain(`internal-note-${RUN}`);
    expect(JSON.stringify(res.json())).not.toContain('UNREADABLE');
    expect(JSON.stringify(res.json())).not.toContain(theirs);
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'DSAR_DOCUMENT_EXPORT', entityId: me } }));
    expect((audit?.changes as { reasonCode?: string })?.reasonCode).toBe('SUBJECT_ACCESS');
  });

  it('the refusal grounds are exactly the obligations: hold, AML record class, an approved licence backing a live relationship — else none', () => {
    expect(refusalGround({ held: true, amlRecord: true, approved: true, relationshipLive: true })).toBe('LEGAL_HOLD');
    expect(refusalGround({ held: false, amlRecord: true, approved: false, relationshipLive: false })).toBe('AML_RECORD');
    expect(refusalGround({ held: false, amlRecord: false, approved: true, relationshipLive: true })).toBe('ACTIVE_LICENCE');
    expect(refusalGround({ held: false, amlRecord: false, approved: true, relationshipLive: false })).toBeNull();
    expect(refusalGround({ held: false, amlRecord: false, approved: false, relationshipLive: true })).toBeNull();
  });

  it('erase: already destroyed → the receipt; held → refused LEGAL_HOLD; AML class → refused AML_RECORD; free → destroyed now with the values crypto-shredded and a receipt', async () => {
    const destroyed = await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId: me, role: 'VENDOR_OWNER', docType: 'storefront_photo', fileUrl: '', status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1', purgedAt: new Date() } }));
    await runWithTenant('swift-default', () => app.prisma.deletionReceipt.create({ data: { submissionId: destroyed.id, subjectId: me, docTypeCode: 'storefront_photo', bytesDeleted: 0n, deletedBy: 'reaper', storeLocations: [], verificationProbeResult: 'CONFIRMED_ABSENT' } }));
    const held = (await submit(me, 'gra_restaurant_licence')).id;
    const hold = await runWithTenant('swift-default', () => app.prisma.docLegalHold.create({ data: { subjectUserId: me, reason: `enquiry ${RUN}`, ownerId: adminId, placedBy: adminId, reviewBy: new Date(Date.now() + 30 * DAY) } }));
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.update({ where: { id: held }, data: { legalHoldId: hold.id } }));
    const aml = (await submit(me, AML_TYPE)).id;
    const res = await erase(me);
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json().data as Array<{ documentId: string; outcome: string; ground?: string; receipt?: { probe: string } }>).map((o) => [o.documentId, o]));
    expect(byId.get(destroyed.id)).toMatchObject({ outcome: 'ALREADY_DESTROYED', receipt: { probe: 'CONFIRMED_ABSENT' } });
    expect(byId.get(held)).toMatchObject({ outcome: 'REFUSED', ground: 'LEGAL_HOLD' });
    expect(byId.get(aml)).toMatchObject({ outcome: 'REFUSED', ground: 'AML_RECORD' });
    expect(byId.get(mine)).toMatchObject({ outcome: 'DESTROYED', receipt: { probe: 'CONFIRMED_ABSENT' } });
    const row = await docRow(mine);
    expect(row.purgedAt).not.toBeNull();
    expect(row.status).toBe('REJECTED'); // the state is untouched; the bytes and the values are gone
    for (const run of row.extractionRuns) { expect(run.wrappedDek).toBeNull(); for (const f of run.fields) expect(f.valueCt).toBeNull(); }
    expect((await docRow(held)).purgedAt).toBeNull();
    expect((await docRow(aml)).purgedAt).toBeNull();
    const after = await get(me);
    expect(after.json().data.documents.find((d: { id: string }) => d.id === mine).fields.find((f: { fieldCode: string }) => f.fieldCode === 'doc_number')).toMatchObject({ value: null, valueUnavailable: false });
  });

  it('rectify: re-opens a review case with the request as provenance, touches no record, tells the admins; the SLA watchdog leaves that case open', async () => {
    const approved = (await submit(me, 'tin_certificate', `TIN ${RUN}-0002`)).id;
    await runWithTenant('swift-default', () => service.approveDocument(approved, adminId));
    const before = await docRow(approved);
    expect((await rectify(me, approved, 'not_a_field')).statusCode).toBe(400);
    const res = await rectify(me, approved, 'doc_number');
    expect(res.statusCode).toBe(201);
    const { requestId, caseId } = res.json().data;
    const kase = await system(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id: caseId } }));
    expect([kase.submissionId, kase.queue, kase.closedAt]).toEqual([approved, 'STANDARD', null]);
    const request = await system(() => app.prisma.rectificationRequest.findUniqueOrThrow({ where: { id: requestId } }));
    expect([request.userId, request.fieldCode, request.resolvedAt]).toEqual([me, 'doc_number', null]);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'DSAR_RECTIFICATION_REQUESTED', entityId: approved } }))).toBe(1);
    const after = await docRow(approved);
    expect(after.extractionRuns.map((r) => r.fields.map((f) => [f.fieldCode, Buffer.from(f.valueCt!).toString('hex')]))).toEqual(before.extractionRuns.map((r) => r.fields.map((f) => [f.fieldCode, Buffer.from(f.valueCt!).toString('hex')])));
    expect(after.status).toBe('APPROVED');
    await service.alertReviewSlaBreaches();
    expect((await system(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id: caseId } }))).closedAt).toBeNull();
    expect((await get(other)).json().data.documents.some((d: { id: string }) => d.id === approved)).toBe(false);
  });

  it('test_no_direct_document_record_mutation: no code path writes an extracted value outside the ledger; the only writers of extracted_field are the two crypto-shreds, and they only null it', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules'].includes(name)) walk(p, out); continue; }
        if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    const writers: Record<string, string[]> = {};
    for (const f of walk(API_SRC)) {
      const src = readFileSync(f, 'utf8');
      const hits = [...src.matchAll(/extractedField\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\(/g)].map((m) => m[1]!);
      const raw = [...src.matchAll(/(UPDATE|INSERT INTO|DELETE FROM)\s+"?extracted_field"?/gi)].map((m) => `raw:${m[1]!.toUpperCase()}`);
      if (hits.length || raw.length) writers[relative(API_SRC, f)] = [...hits, ...raw].sort();
    }
    expect(writers).toEqual({
      'modules/user/account.service.ts': ['updateMany'],
      'modules/verification/verification.service.ts': ['updateMany'],
    });
    for (const f of ['modules/user/account.service.ts', 'modules/verification/verification.service.ts']) {
      const src = readFileSync(join(API_SRC, f), 'utf8');
      for (const m of src.matchAll(/extractedField\.updateMany\(\{[^}]*data:\s*\{([^}]*)\}/g)) expect(m[1]!.trim()).toBe('valueCt: null');
    }
    // the ledger's rows are born through the run's nested create — the one place a value is written
    const ledger = readFileSync(join(API_SRC, 'modules/verification/extraction-ledger.ts'), 'utf8');
    expect(ledger).toContain('fields: { create:');
  });
});
