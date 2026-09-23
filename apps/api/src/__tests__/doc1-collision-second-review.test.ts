/**
 * [DOC-1 §7 V_SHA_COLLISION · DOC-INV-11] test_collision_forces_second_review.
 *
 * The same document bytes already on ANOTHER account: one person opening several
 * accounts, or a reused/forged document. The case opens in the SECOND_REVIEW queue
 * with the reason on the audit row, and both accounts are linked in the identity
 * graph by a HARD signal (the file hash — never the document).
 *
 * [NO-AI] Nothing is approved automatically any more, so the control is not "a
 * unique document auto-approves" but "a unique document queues in STANDARD and
 * carries no DOC_CONTENT signal". The collision changes the QUEUE and the graph,
 * never the decision, which is a person's in both cases.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signupSelfieFixture } from './helpers/verification-object';
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
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { hashSignal } from '../modules/integrity/normalize';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
let app: FastifyInstance;
const ids: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
const SHARED = crypto.createHash('sha256').update(`shared-doc-${RUN}`).digest('hex');
const UNIQUE = crypto.createHash('sha256').update(`unique-doc-${RUN}`).digest('hex');
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-collision-test');

/** An engine that reads a field: the most an adapter can say, and still not a decision. */
class ReadingKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'reading-spy', version: 'test', external: false };
  async verifyDocument(): Promise<KycVerificationResult> { return { referenceToken: `rd_${nanoid(6)}`, extracted: { documentNumber: `DOC-${RUN}` } }; }
}

const fileKeyFor = (who: 'A' | 'B' | 'C') => `/uploads/verification/${ids[who]}/id-${RUN}.enc`;
async function envelope(who: 'A' | 'B' | 'C', sha256: string) {
  await app.prisma.encryptedObject.create({ data: { fileKey: fileKeyFor(who), iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(40, 3), mimeType: 'image/jpeg', sizeBytes: 1000, sha256, createdBy: ids[who] } });
}
const submit = (who: 'A' | 'B' | 'C') =>
  runWithTenant('swift-default', () => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ReadingKyc())
    .submitDocument(ids[who], 'RESTAURANT', 'owner_national_id', fileKeyFor(who), 'v1'));
const openCase = (docId: string) => system(() => app.prisma.reviewCase.findFirstOrThrow({ where: { submissionId: docId, closedAt: null } }));
const docContentKeys = (accountIds: string[]) => system(() => app.prisma.identityKey.findMany({ where: { type: 'DOC_CONTENT', accountId: { in: accountIds } }, select: { accountId: true, valueHash: true } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  for (const [i, who] of (['A', 'B', 'C'] as const).entries()) {
    const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
      phone: `+59271${NUM}${i}`, firstName: 'Dup', lastName: who, activeRole: 'VENDOR_OWNER', countryCode: 'GY', avatar: `avatars/${RUN}/${who}.jpg`, selfieCapturedAt: new Date(),
    } }));
    ids[who] = u.id;
    await signupSelfieFixture(app.prisma, u.id);
  }
});

afterAll(async () => {
  await system(async () => {
    const users = Object.values(ids);
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

describe('[DOC-INV-11] a cross-subject fingerprint collision forces a second review — and nothing is ever approved automatically', () => {
  it('the first account with the document queues for a person in the STANDARD queue, with no DOC_CONTENT signal', async () => {
    await envelope('A', SHARED);
    const a = await submit('A');
    expect(a.status).toBe('PENDING');
    expect(a.reviewedBy).toBeNull();
    expect((await openCase(a.id)).queue).toBe('STANDARD');
    expect(await docContentKeys([ids.A])).toEqual([]);
  });

  it('a second account submitting the SAME bytes lands in SECOND_REVIEW, both accounts are linked by a HARD signal, and the audit row carries the reason', async () => {
    await envelope('B', SHARED);
    const b = await submit('B');
    expect(b.status).toBe('PENDING');
    expect(b.reviewedBy).toBeNull();
    expect((await openCase(b.id)).queue).toBe('SECOND_REVIEW');
    const keys = await docContentKeys([ids.A, ids.B]);
    expect(keys.map((k) => k.accountId).sort()).toEqual([ids.A, ids.B].sort());
    expect(new Set(keys.map((k) => k.valueHash))).toEqual(new Set([hashSignal(SHARED)]));
    // The submission is audited as a submission with its routing and reason — never as a decision.
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { entityId: b.id }, orderBy: { createdAt: 'desc' } }));
    expect(audit?.action).toBe('VERIFICATION_SUBMIT');
    expect(audit?.changes).toMatchObject({ status: 'PENDING', queue: 'SECOND_REVIEW' });
    expect(JSON.stringify(audit?.changes ?? {})).toMatch(/second review|Duplicate/);
  });

  it('control: a unique document queues in STANDARD and carries no DOC_CONTENT signal', async () => {
    await envelope('C', UNIQUE);
    const c = await submit('C');
    expect(c.status).toBe('PENDING');
    expect((await openCase(c.id)).queue).toBe('STANDARD');
    expect(await docContentKeys([ids.C])).toEqual([]);
  });
});
