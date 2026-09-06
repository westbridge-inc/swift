/**
 * [DOC-1 Part XXI · DOC-INV-28 · P21] test_no_approval_path_during_extraction_outage
 *
 * Fail closed on anything that would grant access, fail open on anything that merely
 * delays it. An extraction adapter that throws or hangs is an outage, not a verdict: the
 * submission is accepted and queued for a human, its run records the outage, and no
 * approval path exists. A model whose recent runs violate the schema too often is cut
 * off per document type (manual keying) and the admins are told once. In production the
 * key service is a precondition for intake and approvals; without it the door is closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { extractWithLadder, degradedProvider, assertKeyServiceForAccess, l3BreakerOpen, EXTRACTION_UNAVAILABLE, L3_DISABLED, BREAKER_WINDOW } from '../modules/verification/degradation';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { documentRecordDdl } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const KEK = Buffer.alloc(32, 9).toString('base64');
const prevKek = process.env['MASTER_KEK'];

let app: FastifyInstance;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-degradation-test');
const svc = (kyc: KycProvider) => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);

/** A processor that says "approved" with fields — the answer an outage must never turn into an approval. */
class ApprovingKyc implements KycProvider {
  readonly engine = { name: 'approving', version: 'test', external: false };
  async verifyIdentity(): Promise<KycVerificationResult> { return this.result(); }
  async verifyDocument(): Promise<KycVerificationResult> { return this.result(); }
  async getStatus(): Promise<'approved'> { return 'approved'; }
  private result(): KycVerificationResult { return { status: 'approved', referenceToken: `ok_${nanoid(5)}`, extracted: { documentNumber: `DN${RUN}` }, confidence: 0.99 }; }
}

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59264${NUM}${n}`, firstName: 'Deg', lastName: `Rade${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
const submit = (service: VerificationService, userId: string, docType = 'business_registration') =>
  runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', docType, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
const runOf = (docId: string) => system(() => app.prisma.extractionRun.findFirstOrThrow({ where: { submissionId: docId }, include: { fields: true } }));
const docOf = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { state: true, status: true, record: { select: { status: true } } } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = KEK; resetKeyProviderForTests(); // values are stored only under a key: the healthy run must store one
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek;
  resetKeyProviderForTests();
  await system(async () => {
    await app.prisma.extractionRun.deleteMany({ where: { profileCode: `BREAKER_${RUN}` } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { data: { path: ['profileCode'], equals: `BREAKER_${RUN}` } }] } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P21] the ladder', () => {
  it('a thrown adapter is an outage: the submission is accepted, queued for a human, the run records the outage, and no approval path exists', async () => {
    const u = await owner(1);
    const doc = await submit(svc(degradedProvider(new ApprovingKyc(), 'throw')), u);
    expect(await docOf(doc.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING', record: null });
    const run = await runOf(doc.id);
    expect(run).toMatchObject({ outcome: 'FAILED', errorClass: EXTRACTION_UNAVAILABLE });
    expect(run.fields).toHaveLength(0);
    expect(await system(() => app.prisma.reviewCase.count({ where: { submissionId: doc.id, closedAt: null } }))).toBe(1);
  });

  it('a hung adapter is cut by the bound and treated the same way', async () => {
    const prev = process.env['EXTRACTION_TIMEOUT_MS']; process.env['EXTRACTION_TIMEOUT_MS'] = '300';
    try {
      const u = await owner(2);
      const started = Date.now();
      const doc = await submit(svc(degradedProvider(new ApprovingKyc(), 'hang')), u);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await docOf(doc.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING' });
      expect((await runOf(doc.id)).errorClass).toBe(EXTRACTION_UNAVAILABLE);
      const r = await extractWithLadder(() => new Promise<KycVerificationResult>(() => undefined), { timeoutMs: 50 });
      expect(r).toMatchObject({ status: 'pending_manual', degraded: EXTRACTION_UNAVAILABLE });
    } finally {
      if (prev === undefined) delete process.env['EXTRACTION_TIMEOUT_MS']; else process.env['EXTRACTION_TIMEOUT_MS'] = prev;
    }
  });

  it('the breaker: more than 10% schema violations over the last 100 runs disables the model leg for that type — manual keying, no fields taken, admins told once', async () => {
    const u = await owner(3);
    const code = registryCode('GY', 'tin_certificate');
    const profileCode = `BREAKER_${RUN}`;
    await system(() => app.prisma.docType.update({ where: { code }, data: { extractionProfile: profileCode } }));
    // declare the field the processor returns, so a NON-degraded run would store it — the degraded run must not
    await system(() => app.prisma.docField.deleteMany({ where: { docTypeCode: code, fieldCode: 'doc_number' } }));
    await system(() => app.prisma.docField.create({ data: { docTypeCode: code, fieldCode: 'doc_number', dataType: 'text', isRequired: false, isPii: true, isBlindIndexed: false, displayOrder: 1 } }));
    const seed = await submit(svc(new ApprovingKyc()), u, 'tin_certificate'); // establishes a run on the profile
    const healthy = await runOf(seed.id);
    expect(healthy.fields.map((f) => f.fieldCode)).toEqual(['doc_number']);
    expect(healthy.fields[0]!.valueCt).not.toBeNull(); // the healthy path stores the value (encrypted)
    const tenantId = 'swift-default';
    await system(() => app.prisma.extractionRun.createMany({ data: Array.from({ length: BREAKER_WINDOW }, (_, i) => ({
      submissionId: seed.id, tenantId, profileCode, engineName: 'approving', engineVersion: 'test', startedAt: new Date(Date.now() - (i + 1) * 1000), outcome: 'OK' as const, schemaViolations: i < 12 ? 1 : 0,
    })) }));
    expect((await system(() => l3BreakerOpen(app.prisma, profileCode))).open).toBe(true);
    const u2 = await owner(4);
    const doc = await submit(svc(new ApprovingKyc()), u2, 'tin_certificate');
    expect(await docOf(doc.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING' });
    const run = await runOf(doc.id);
    expect(run).toMatchObject({ outcome: 'FAILED', errorClass: L3_DISABLED });
    expect(run.fields.every((f) => f.valueCt === null)).toBe(true); // the declared row exists, but no value was taken from the processor
    const pages = () => system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'ops_extraction_breaker_open' }, body: { contains: profileCode } } }));
    expect(await pages()).toBeGreaterThanOrEqual(1);
    const before = await pages();
    await submit(svc(new ApprovingKyc()), u2, 'tin_certificate').catch(() => undefined);
    expect(await pages()).toBe(before);
    await system(() => app.prisma.docType.update({ where: { code }, data: { extractionProfile: 'UNPROFILED' } }));
    await system(() => app.prisma.docField.deleteMany({ where: { docTypeCode: code, fieldCode: 'doc_number' } }));
  });

  it('in production, intake and approvals fail CLOSED without the key service; outside production the check is silent', () => {
    const prevEnv = process.env['NODE_ENV']; const prevKek = process.env['MASTER_KEK'];
    try {
      process.env['NODE_ENV'] = 'production'; delete process.env['MASTER_KEK']; resetKeyProviderForTests();
      expect(() => assertKeyServiceForAccess('intake')).toThrow(/KEY_SERVICE_UNAVAILABLE|key service is unavailable/);
      expect(() => assertKeyServiceForAccess('approval')).toThrow(/paused/);
      process.env['MASTER_KEK'] = Buffer.alloc(32, 7).toString('base64'); resetKeyProviderForTests();
      expect(() => assertKeyServiceForAccess('intake')).not.toThrow();
      process.env['NODE_ENV'] = 'test'; delete process.env['MASTER_KEK']; resetKeyProviderForTests();
      expect(() => assertKeyServiceForAccess('intake')).not.toThrow();
    } finally {
      process.env['NODE_ENV'] = prevEnv; if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek; resetKeyProviderForTests();
    }
  });
});
