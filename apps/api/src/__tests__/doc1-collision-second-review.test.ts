/**
 * [DOC-1 §7 V_SHA_COLLISION · DOC-INV-11] test_collision_forces_second_review.
 *
 * The same document bytes already on ANOTHER account never auto-approve: the
 * provider's clean verdict is overruled to human review, and both accounts are
 * linked in the identity graph by a HARD signal (the file's hash — never the
 * document). A unique document with the same clean verdict still auto-approves
 * (the control), and a bad document is still rejected.
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
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { hashSignal } from '../modules/integrity/normalize';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
let app: FastifyInstance;
const ids: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
const SHARED = crypto.createHash('sha256').update(`shared-doc-${RUN}`).digest('hex');
const UNIQUE = crypto.createHash('sha256').update(`unique-doc-${RUN}`).digest('hex');
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-collision-test');

class ApprovingKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: `ok_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'approved', referenceToken: `ok_${nanoid(6)}` }; }
  async getStatus(): Promise<'approved'> { return 'approved'; }
}

const fileKeyFor = (who: string) => `/uploads/verification/${who}-${RUN}/id.jpg.enc`;
async function envelope(who: 'A' | 'B' | 'C', sha256: string) {
  await app.prisma.encryptedObject.create({ data: { fileKey: fileKeyFor(who), iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(40, 3), mimeType: 'image/jpeg', sizeBytes: 1000, sha256, createdBy: ids[who] } });
}
const submit = (who: 'A' | 'B' | 'C') =>
  runWithTenant('swift-default', () => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ApprovingKyc())
    .submitDocument(ids[who], 'RESTAURANT', 'owner_national_id', fileKeyFor(who), 'v1'));

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
  }
});

afterAll(async () => {
  await system(async () => {
    const users = Object.values(ids);
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-INV-11] a cross-subject fingerprint collision never auto-approves', () => {
  it('the first account with the document auto-approves on a clean verdict', async () => {
    await envelope('A', SHARED);
    const a = await submit('A');
    expect(a.status).toBe('APPROVED');
  });

  it('a second account submitting the SAME bytes is held for human review despite the clean verdict, and both accounts are linked by a HARD signal', async () => {
    await envelope('B', SHARED);
    const b = await submit('B');
    expect(b.status).not.toBe('APPROVED');
    expect(b.status).toBe('PENDING');
    const keys = await system(() => app.prisma.identityKey.findMany({ where: { type: 'DOC_CONTENT', accountId: { in: [ids.A, ids.B] } }, select: { accountId: true, valueHash: true } }));
    expect(keys.map((k) => k.accountId).sort()).toEqual([ids.A, ids.B].sort());
    expect(new Set(keys.map((k) => k.valueHash))).toEqual(new Set([hashSignal(SHARED)]));
    // The decision is audited with its reason (recordDecision → auditLog.changes.reason).
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { entityId: b.id }, orderBy: { createdAt: 'desc' } }));
    expect(JSON.stringify(audit?.changes ?? {})).toMatch(/second review|Duplicate/);
  });

  it('control: a unique document with the same clean verdict auto-approves, and carries no DOC_CONTENT signal', async () => {
    await envelope('C', UNIQUE);
    const c = await submit('C');
    expect(c.status).toBe('APPROVED');
    expect(await system(() => app.prisma.identityKey.count({ where: { type: 'DOC_CONTENT', accountId: ids.C } }))).toBe(0);
  });
});
