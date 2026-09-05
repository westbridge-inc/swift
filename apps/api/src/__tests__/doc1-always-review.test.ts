/**
 * [DOC-1 §6.9 · P6-4] test_always_review_set — routing after extraction.
 *
 * Once the registry speaks for a document type (ACTIVE: legal facts verified), a
 * processor approval stands only when auto_approve_eligible holds: every blocking
 * validator PASS (a SKIP is not a PASS), processor confidence known and at or
 * above the type's threshold, no cross-subject collision, and the type outside
 * the always-review set — every PERSONAL document, the insurance certificate,
 * anything still needing a specimen. Until a type is active the legacy verdict
 * holds (minus the §0.5 gate, held by `test_blocking_fail_never_auto_approves`
 * in doc1-extraction-ledger), so activation is the one switch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { alwaysReview, autoApproveEligible, type ExtractionPlan } from '../modules/verification/extraction-ledger';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
/** BUSINESS with a declared field (the positive path), PERSONAL (always review), BUSINESS with nothing declared (SKIP ≠ PASS). */
const BUSINESS = 'tin_certificate';
const PERSONAL = 'food_handler_cert';
const UNDECLARED = 'storefront_photo';
const CODES = { BUSINESS: registryCode('GY', BUSINESS), PERSONAL: registryCode('GY', PERSONAL), UNDECLARED: registryCode('GY', UNDECLARED) };
const KEK = crypto.randomBytes(32).toString('base64');
const prevKek = process.env['MASTER_KEK'];

let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-always-review-test');

class SpyKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'spy', version: 'test', external: false };
  verdict: KycVerificationResult['status'] = 'approved';
  extracted: Record<string, unknown> | undefined;
  confidence: number | undefined;
  private result(): KycVerificationResult {
    return { status: this.verdict, referenceToken: `spy_${nanoid(6)}`, extracted: this.extracted as KycVerificationResult['extracted'], confidence: this.confidence };
  }
  async verifyIdentity(): Promise<KycVerificationResult> { return this.result(); }
  async verifyDocument(): Promise<KycVerificationResult> { return this.result(); }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}
const kyc = new SpyKyc();

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59272${NUM}${n}`, firstName: 'Route', lastName: `R${n}`, activeRole: 'VENDOR_OWNER', countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
const submit = (userId: string, docType: string) =>
  runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', docType, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
const setActive = (code: string, on: boolean) => system(() => app.prisma.docType.update({ where: { code }, data: { isActive: on, legalFactsVerifiedAt: on ? new Date() : null } }));
const openCases = (docId: string) => system(() => app.prisma.reviewCase.findMany({ where: { submissionId: docId, closedAt: null } }));
const readOnly = () => { kyc.verdict = 'approved'; kyc.extracted = { documentNumber: `TIN-${RUN}-${nanoid(4)}` }; };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = KEK;
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
  await system(async () => {
    await seedDocRegistry(app.prisma);
    for (const code of Object.values(CODES)) await app.prisma.docType.update({ where: { code }, data: { isActive: false, legalFactsVerifiedAt: null, needsSpecimen: false } });
    await app.prisma.docField.deleteMany({ where: { docTypeCode: { in: [CODES.BUSINESS, CODES.PERSONAL] }, fieldCode: 'doc_number' } });
    await app.prisma.docField.createMany({ data: [CODES.BUSINESS, CODES.PERSONAL].map((docTypeCode) => (
      { docTypeCode, fieldCode: 'doc_number', dataType: 'text', isRequired: true, isPii: true, isBlindIndexed: true, displayOrder: 1 }
    )) });
  });
});

afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.docField.deleteMany({ where: { docTypeCode: { in: [CODES.BUSINESS, CODES.PERSONAL] }, fieldCode: 'doc_number' } });
    for (const code of Object.values(CODES)) await app.prisma.docType.update({ where: { code }, data: { isActive: false, legalFactsVerifiedAt: null, needsSpecimen: false } });
  });
  if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek;
  resetKeyProviderForTests();
  await app.close();
});

describe('[DOC-1 P6-4] routing after extraction — auto_approve_eligible (§6.9)', () => {
  it('the always-review set is exactly §6.9: every PERSONAL document, anything needing a specimen, and the registry fact — the insurance certificate carries it, its neighbours do not', async () => {
    expect(alwaysReview({ bucket: 'PERSONAL', needsSpecimen: false, alwaysReview: false })).toBe(true);
    expect(alwaysReview({ bucket: 'BUSINESS', needsSpecimen: true, alwaysReview: false })).toBe(true);
    expect(alwaysReview({ bucket: 'VEHICLE', needsSpecimen: false, alwaysReview: true })).toBe(true);
    expect(alwaysReview({ bucket: 'BUSINESS', needsSpecimen: false, alwaysReview: false })).toBe(false);
    const rows = await system(() => app.prisma.docType.findMany({ where: { countryCode: 'GY', bucket: 'VEHICLE' }, select: { legacyCode: true, alwaysReview: true } }));
    const flagged = rows.filter((r) => r.alwaysReview).map((r) => r.legacyCode);
    expect(flagged).toEqual(['vehicle_insurance']);
    expect(rows.length).toBeGreaterThan(1);
  });

  it('a SKIP is not a PASS: an active type with nothing validated is never eligible, whatever the confidence', () => {
    const plan = {
      run: { confidence: 1 }, fields: [], blockingFail: false,
      validations: [{ validatorCode: 'V_ALL_REQUIRED_PRESENT', status: 'SKIP', detailCode: 'NO_DECLARED_FIELDS', isBlocking: true }],
    } as unknown as ExtractionPlan;
    const type = { isActive: true, bucket: 'BUSINESS' as const, needsSpecimen: false, alwaysReview: false, minConfidenceAutoApprove: 0.97 };
    expect(autoApproveEligible(plan, type, false)).toEqual({ eligible: false, reason: 'NOT_VALIDATED' });
    expect(autoApproveEligible(plan, { ...type, isActive: false }, false)).toEqual({ eligible: true, reason: null });
  });

  it('the reasons are told apart: unknown confidence is CONFIDENCE_UNKNOWN, a low one is BELOW_THRESHOLD, a collision is COLLISION, the threshold is inclusive', () => {
    const validated = {
      fields: [], blockingFail: false,
      validations: [{ validatorCode: 'V_ALL_REQUIRED_PRESENT', status: 'PASS', detailCode: null, isBlocking: true }],
    };
    const type = { isActive: true, bucket: 'BUSINESS' as const, needsSpecimen: false, alwaysReview: false, minConfidenceAutoApprove: 0.97 };
    const withConf = (confidence: number | null) => ({ ...validated, run: { confidence } }) as unknown as ExtractionPlan;
    expect(autoApproveEligible(withConf(null), type, false)).toEqual({ eligible: false, reason: 'CONFIDENCE_UNKNOWN' });
    expect(autoApproveEligible(withConf(0.969), type, false)).toEqual({ eligible: false, reason: 'CONFIDENCE_BELOW_THRESHOLD' });
    expect(autoApproveEligible(withConf(0.97), type, false)).toEqual({ eligible: true, reason: null });
    expect(autoApproveEligible(withConf(1), type, true)).toEqual({ eligible: false, reason: 'COLLISION' });
    expect(autoApproveEligible({ ...withConf(1), blockingFail: true } as ExtractionPlan, type, false)).toEqual({ eligible: false, reason: 'BLOCKING_FAIL' });
  });

  it('registry silent (type inactive): the processor approval stands without any confidence — activation is the one switch', async () => {
    const u = await owner(1);
    expect((await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: CODES.BUSINESS } }))).isActive).toBe(false);
    readOnly(); kyc.confidence = undefined;
    const doc = await submit(u, BUSINESS);
    expect(doc.status).toBe('APPROVED');
  });

  it('active BUSINESS type: fields read, confidence at the threshold, no collision → the approval stands and the run records the confidence', async () => {
    await setActive(CODES.BUSINESS, true);
    const u = await owner(2);
    readOnly(); kyc.confidence = 0.97;
    const doc = await submit(u, BUSINESS);
    expect(doc.status).toBe('APPROVED');
    const run = await system(() => app.prisma.extractionRun.findFirstOrThrow({ where: { submissionId: doc.id } }));
    expect(Number(run.confidence)).toBe(0.97);
  });

  it('active + confidence unknown → a person reviews it (CONFIDENCE_UNKNOWN)', async () => {
    const u = await owner(3);
    readOnly(); kyc.confidence = undefined;
    const doc = await submit(u, BUSINESS);
    expect(doc.status).toBe('PENDING');
    expect((await openCases(doc.id)).map((c) => c.queue)).toEqual(['STANDARD']);
  });

  it('active + confidence below the type threshold (0.97) → review', async () => {
    const u = await owner(4);
    readOnly(); kyc.confidence = 0.9;
    const doc = await submit(u, BUSINESS);
    expect(doc.status).toBe('PENDING');
    expect(await openCases(doc.id)).toHaveLength(1);
  });

  it('active PERSONAL type with everything read at confidence 1.0 → still a person (ALWAYS_REVIEW)', async () => {
    await setActive(CODES.PERSONAL, true);
    const u = await owner(5);
    readOnly(); kyc.confidence = 1;
    const doc = await submit(u, PERSONAL);
    expect(doc.status).toBe('PENDING');
    expect((await openCases(doc.id)).map((c) => c.queue)).toEqual(['STANDARD']);
  });

  it('active type with no declared fields: the verdict is SKIP, and SKIP never auto-approves (NOT_VALIDATED)', async () => {
    await setActive(CODES.UNDECLARED, true);
    const u = await owner(6);
    kyc.verdict = 'approved'; kyc.extracted = undefined; kyc.confidence = 1;
    const doc = await submit(u, UNDECLARED);
    expect(doc.status).toBe('PENDING');
    const v = await system(() => app.prisma.validationResult.findFirstOrThrow({ where: { submissionId: doc.id, validatorCode: 'V_ALL_REQUIRED_PRESENT' } }));
    expect(v.status).toBe('SKIP');
  });

  it('a type that still needs a specimen is always reviewed, even when everything else is eligible', async () => {
    await system(() => app.prisma.docType.update({ where: { code: CODES.BUSINESS }, data: { needsSpecimen: true } }));
    try {
      const u = await owner(7);
      readOnly(); kyc.confidence = 1;
      const doc = await submit(u, BUSINESS);
      expect(doc.status).toBe('PENDING');
    } finally {
      await system(() => app.prisma.docType.update({ where: { code: CODES.BUSINESS }, data: { needsSpecimen: false } }));
    }
  });
});
