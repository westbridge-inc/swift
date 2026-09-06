/**
 * [DOC-1 §4.4 · DOC-INV-7] test_purge_receipt_and_probe — every purge writes a
 * deletion_receipt with a passing verification probe.
 *
 * The reaper purges a due document: bytes deleted, key shredded, a REAL read
 * attempt confirms absence, and the receipt (carrying the envelope's recorded
 * sha256, the byte count, every store location, 'reaper') commits in the same
 * transaction as the purge mark. A store that keeps the bytes yields a FAILED
 * probe, and the reaper leaves such a row due. Receipts are append-only. Every
 * code path that marks a document purged writes a receipt — a census.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { allRlsDdl, appRoleDdl, deletionReceiptAppendOnlyDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { LocalStorageProvider, type StorageProvider } from '../providers/storage/storage-provider';
import { shredAndProbe, writeDeletionReceipt } from '../modules/verification/purge-receipt';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const API_SRC = join(__dirname, '..');
let app: FastifyInstance;
let userId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-purge-receipt-test');
const storage = new LocalStorageProvider();

async function storedDocument(original: Buffer, retentionExpiresAt: Date) {
  const { url } = await storage.upload({ buffer: original, filename: `doc-${nanoid(6)}.jpg`, mimeType: 'image/jpeg', folder: 'documents' });
  const sha256 = crypto.createHash('sha256').update(original).digest('hex');
  await app.prisma.encryptedObject.create({ data: { fileKey: url, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(40, 3), mimeType: 'image/jpeg', sizeBytes: original.length, sha256, createdBy: userId } });
  const doc = await app.prisma.verificationDocument.create({ data: { userId, role: 'RIDER', docType: 'national_id', fileUrl: url, status: 'APPROVED', retentionExpiresAt } });
  return { url, sha256, doc };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await installDdl(app.prisma, [...appRoleDdl(), ...allRlsDdl(), ...deletionReceiptAppendOnlyDdl()]);
  userId = (await system(() => app.prisma.user.create({ data: { phone: `+59273${NUM}7`, firstName: 'Purge', lastName: 'Receipt', activeRole: 'RIDER' } }))).id;
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  });
  await app.close();
});

describe('[DOC-INV-7] proof of purge', () => {
  it('the reaper purges a due document and writes a CONFIRMED_ABSENT receipt in the same transaction — bytes gone, key gone, hash and size recorded', async () => {
    const original = Buffer.from(`original-${RUN}-` + 'x'.repeat(500));
    const { url, sha256, doc } = await storedDocument(original, new Date(Date.now() - 86_400_000));
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    const purged = await system(() => service.purgeExpiredDocuments());
    expect(purged).toBeGreaterThanOrEqual(1);
    const row = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }));
    expect(row.purgedAt).toBeInstanceOf(Date);
    expect(row.fileUrl).toBe('');
    const receipt = await system(() => app.prisma.deletionReceipt.findFirstOrThrow({ where: { submissionId: doc.id } }));
    expect(receipt.verificationProbeResult).toBe('CONFIRMED_ABSENT');
    expect(receipt.deletedBy).toBe('reaper');
    expect(receipt.subjectId).toBe(userId);
    expect(receipt.tenantId).toBe('swift-default');
    expect(receipt.docTypeCode).toBe('national_id');
    expect(Buffer.from(receipt.contentSha256!).toString('hex')).toBe(sha256);
    expect(Number(receipt.bytesDeleted)).toBe(original.length);
    expect(receipt.storeLocations).toEqual([`storage:${url}`, `encrypted_object:${url}`]);
    await expect(storage.getObject(url)).rejects.toThrow();
    const envelope = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: url } });
    expect(envelope.wrappedDek).toBeNull();
    expect(envelope.shreddedAt).toBeInstanceOf(Date);
    // A second sweep finds nothing due for this document: exactly one receipt.
    await system(() => service.purgeExpiredDocuments());
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: doc.id } }))).toBe(1);
  });

  it('a store that keeps the bytes yields a FAILED probe — and a FAILED receipt says so', async () => {
    const original = Buffer.from(`sticky-${RUN}`);
    const { url, sha256, doc } = await storedDocument(original, new Date(Date.now() + 86_400_000));
    const sticky: StorageProvider = {
      upload: storage.upload.bind(storage),
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: async () => undefined,
      getObject: async () => original,
    };
    const evidence = await system(() => shredAndProbe(app.prisma, sticky, url));
    expect(evidence.probe).toBe('FAILED');
    expect(evidence.sha256 && Buffer.from(evidence.sha256).toString('hex')).toBe(sha256);
    expect(Number(evidence.bytesDeleted)).toBe(original.length);
    const receipt = await system(() => writeDeletionReceipt(app.prisma, { submissionId: doc.id, subjectId: userId, tenantId: 'swift-default', docTypeCode: 'national_id', deletedBy: 'reaper', evidence }));
    expect(receipt.verificationProbeResult).toBe('FAILED');
    // the real store still has the object (the spy never deleted it); clean it
    await storage.delete(url);
  });

  it('the reaper leaves a FAILED row due (never marks it purged), and every purge writer writes a receipt — a census', () => {
    const service = readFileSync(join(API_SRC, 'modules', 'verification', 'verification.service.ts'), 'utf8');
    // [P25] The one purge of one document is purgeDocumentNow: a FAILED probe writes its receipt and returns before anything is marked purged.
    expect(service).toMatch(/if \(evidence\.probe === 'FAILED'\) \{\s*await writeDeletionReceipt\(this\.prisma, receipt\);\s*return 'PROBE_FAILED';/);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules'].includes(name)) walk(p, out); continue; }
        if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    // `purgedAt` is also a StorageOrphan field: only files that write verification documents count.
    const writers = walk(API_SRC).filter((f) => { const src = readFileSync(f, 'utf8'); return /purgedAt: new Date\(\)/.test(src) && /verificationDocument\./.test(src); });
    for (const f of writers) {
      expect(readFileSync(f, 'utf8'), `${relative(API_SRC, f)} marks documents purged without a receipt`).toMatch(/writeDeletionReceipt\(/);
    }
    expect(writers.map((f) => relative(API_SRC, f)).sort()).toEqual(['modules/user/account.service.ts', 'modules/verification/verification.service.ts']);
  });

  it('receipts are append-only: no update, no delete', async () => {
    const receipt = await system(() => app.prisma.deletionReceipt.findFirstOrThrow({ where: { subjectId: userId } }));
    await expect(system(() => app.prisma.deletionReceipt.update({ where: { id: receipt.id }, data: { verificationProbeResult: 'CONFIRMED_ABSENT' } }))).rejects.toThrow(/append-only/);
    await expect(system(() => app.prisma.deletionReceipt.delete({ where: { id: receipt.id } }))).rejects.toThrow(/append-only/);
    await expect(app.prisma.$executeRaw(Prisma.sql`DELETE FROM deletion_receipt WHERE id = ${receipt.id}::uuid`)).rejects.toThrow(/append-only/);
  });
});
