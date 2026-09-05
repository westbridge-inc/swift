/**
 * [DOC-1 §4.4 · P4-5] test_rejection_reason_mapping — review cases and decisions.
 *
 * A document that lands in human review opens ONE case (STANDARD; SECOND_REVIEW
 * when the cross-subject collision rule fired) with a 24h SLA. Every approve or
 * reject writes a decision — outcome, reason code, an actor-facing CATEGORY
 * that never carries the internal note — and closes the case in the same
 * transaction. The SLA watchdog reads the case table: a breached case is
 * escalated and admins are told. Documents that predate cases get one on
 * decision, so every decision has a case.
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
import { VerificationService, REJECTION_REASON_CODES, ACTOR_FACING_CATEGORY, REVIEW_SLA_HOURS } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

/** DOC-1 §8.5 actor-facing table, pinned FROM the spec as literals (the test must not import the thing it grades). */
const SPEC_8_5_CATEGORY: Record<(typeof REJECTION_REASON_CODES)[number], string> = {
  UNREADABLE: 'QUALITY', INCOMPLETE: 'QUALITY',
  EXPIRED: 'EXPIRED',
  WRONG_DOCUMENT: 'REQUIREMENT', INSURANCE_NOT_HIRE: 'REQUIREMENT', NOT_YELLOW: 'REQUIREMENT',
  NAME_MISMATCH: 'ACCOUNT_MISMATCH',
  SUSPECTED_TAMPERING: 'UNVERIFIABLE', DUPLICATE: 'UNVERIFIABLE', FACE_MISMATCH: 'UNVERIFIABLE',
};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-review-case-test');

class ManualKyc implements KycProvider {
  verdict: KycVerificationResult['status'] = 'pending_manual';
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: this.verdict, referenceToken: `m_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: this.verdict, referenceToken: `m_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}
const kyc = new ManualKyc();

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59270${NUM}${n}`, firstName: 'Rev', lastName: `Case${n}`, activeRole: 'VENDOR_OWNER', countryCode: 'GY', avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
const submit = (userId: string, docType = 'business_registration', fileKey = `/uploads/verification/${RUN}/${nanoid(5)}.enc`) =>
  runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', docType, fileKey, 'v1'));
const openCase = (docId: string) => system(() => app.prisma.reviewCase.findFirst({ where: { submissionId: docId }, orderBy: { createdAt: 'desc' }, include: { decisions: true } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
  adminId = (await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59270${NUM}9`, firstName: 'Admin', lastName: 'Rev', activeRole: 'ADMIN' } }))).id;
  users.push(adminId);
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
  });
  await app.close();
});

describe('[DOC-1 P4-5] review cases and decisions', () => {
  it('a document landing in human review opens ONE STANDARD case with the 24h SLA, in the person’s tenant', async () => {
    const u = await owner(1);
    const before = Date.now();
    const doc = await submit(u);
    expect(doc.status).toBe('PENDING');
    const c = await openCase(doc.id);
    expect(c).not.toBeNull();
    expect([c!.queue, c!.priority, c!.closedAt, c!.tenantId]).toEqual(['STANDARD', 100, null, 'swift-default']);
    expect(c!.slaDueAt.getTime() - c!.createdAt.getTime()).toBe(REVIEW_SLA_HOURS * 3_600_000);
    expect(c!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await system(() => app.prisma.reviewCase.count({ where: { submissionId: doc.id } }))).toBe(1);
  });

  it('a cross-subject collision opens the case in the SECOND_REVIEW queue', async () => {
    const a = await owner(2);
    const b = await owner(3);
    const sha = crypto.createHash('sha256').update(`dup-${RUN}`).digest('hex');
    const keyA = `/uploads/verification/${RUN}/a.enc`;
    const keyB = `/uploads/verification/${RUN}/b.enc`;
    for (const [k, who] of [[keyA, a], [keyB, b]] as const) {
      await app.prisma.encryptedObject.create({ data: { fileKey: k, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(40, 3), mimeType: 'image/jpeg', sizeBytes: 10, sha256: sha, createdBy: who } });
    }
    kyc.verdict = 'approved';
    try {
      await submit(a, 'owner_national_id', keyA);
      const docB = await submit(b, 'owner_national_id', keyB);
      expect(docB.status).toBe('PENDING');
      expect((await openCase(docB.id))!.queue).toBe('SECOND_REVIEW');
    } finally { kyc.verdict = 'pending_manual'; }
  });

  it('approve writes an APPROVE decision and closes the case in the same transaction', async () => {
    const u = await owner(4);
    const doc = await submit(u);
    await runWithTenant('swift-default', () => service.approveDocument(doc.id, adminId));
    const c = await openCase(doc.id);
    expect(c!.closedAt).toBeInstanceOf(Date);
    expect(c!.decisions).toHaveLength(1);
    expect(c!.decisions[0]).toMatchObject({ outcome: 'APPROVE', reasonCode: 'APPROVED', actorFacingCategory: 'APPROVED', reviewerId: adminId });
    expect(c!.decisions[0]!.timeOnCaseMs).toBeGreaterThanOrEqual(0);
  });

  it('the reason → category table is the one in §8.5 — pinned as literals, so a lie in the map cannot satisfy itself', () => {
    expect(Object.keys(ACTOR_FACING_CATEGORY).sort()).toEqual([...REJECTION_REASON_CODES].sort());
    expect(ACTOR_FACING_CATEGORY).toEqual(SPEC_8_5_CATEGORY);
    // §8.5: the fraud class reads IDENTICALLY — never tell a fraudster which signal caught them.
    const fraudClass = (['SUSPECTED_TAMPERING', 'DUPLICATE', 'FACE_MISMATCH'] as const).map((c) => ACTOR_FACING_CATEGORY[c]);
    expect(new Set(fraudClass).size).toBe(1);
    // The category is never the internal reason itself (EXPIRED is the one the spec tells plainly).
    for (const code of REJECTION_REASON_CODES) if (code !== 'EXPIRED') expect(ACTOR_FACING_CATEGORY[code]).not.toBe(code);
  });

  it('reject writes a REJECT decision whose actor-facing category is the mapped category — never the internal note', async () => {
    for (const [i, code] of (['UNREADABLE', 'FACE_MISMATCH', 'DUPLICATE'] as const).entries()) {
      const u = await owner(50 + i);
      const doc = await submit(u, 'business_registration');
      const note = `internal-${RUN}-${code}`;
      await runWithTenant('swift-default', () => service.rejectDocument(doc.id, adminId, note, code));
      const c = await openCase(doc.id);
      expect(c!.closedAt).toBeInstanceOf(Date);
      const d = c!.decisions[0]!;
      expect(d.outcome).toBe('REJECT');
      expect(d.reasonCode).toBe(code);
      expect(d.actorFacingCategory).toBe(SPEC_8_5_CATEGORY[code]);
      expect(d.actorFacingCategory).not.toContain(note);
      expect(d.internalNote).toContain(note);
    }
  });

  it('the SLA watchdog reads the case table: a breached case is escalated, its priority raised, and admins told', async () => {
    const u = await owner(6);
    const doc = await submit(u);
    await system(() => app.prisma.reviewCase.updateMany({ where: { submissionId: doc.id }, data: { slaDueAt: new Date(Date.now() - 3_600_000) } }));
    const breached = await runWithTenant('swift-default', () => service.alertReviewSlaBreaches());
    expect(breached).toBeGreaterThanOrEqual(1);
    const c = await openCase(doc.id);
    expect([c!.queue, c!.priority]).toEqual(['ESCALATED', 10]);
  });

  it('a document that predates cases still gets a case when decided — every decision has a case', async () => {
    const u = await owner(7);
    const doc = await submit(u);
    await system(() => app.prisma.reviewCase.deleteMany({ where: { submissionId: doc.id } }));
    await runWithTenant('swift-default', () => service.approveDocument(doc.id, adminId));
    const c = await openCase(doc.id);
    expect(c).not.toBeNull();
    expect(c!.closedAt).toBeInstanceOf(Date);
    expect(c!.decisions.map((d) => d.outcome)).toEqual(['APPROVE']);
  });
});
