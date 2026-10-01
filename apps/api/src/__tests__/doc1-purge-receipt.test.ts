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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
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
import { type StorageProvider } from '../providers/storage/storage-provider';
import { claimDocumentPurge, probeCommittedPurge, finishDocumentPurge } from '../modules/verification/purge-fence';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const API_SRC = join(__dirname, '..');
let app: FastifyInstance;
let userId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-purge-receipt-test');
const objects = vi.hoisted(() => new Map<string, Buffer>());
const storage = vi.hoisted(() => ({
  purgeNamespace: async () => 'synthetic:receipt',
  upload: async () => { throw new Error('Only synthetic objects in this suite'); },
  getSignedUrl: async () => { throw new Error('No rendering in this suite'); },
  delete: async (key: string) => { objects.delete(key); },
  getObject: async (key: string) => { const b = objects.get(key); if (!b) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return b; },
}));
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));

async function storedDocument(original: Buffer, retentionExpiresAt: Date) {
  const url = `/uploads/verification/${userId}/${nanoid(16)}.enc`;
  objects.set(url, original);
  const sha256 = crypto.createHash('sha256').update(original).digest('hex');
  await app.prisma.encryptedObject.create({ data: { fileKey: url, storageNamespace: 'synthetic:receipt', iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(40, 3), mimeType: 'image/jpeg', sizeBytes: original.length, sha256, createdBy: userId } });
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
  // Retain the synthetic claim/source/receipt custody records; authority is permanent.
  await app.close();
});

describe('[DOC-INV-7] proof of purge', () => {
  it('the reaper purges a due document and writes a CONFIRMED_ABSENT receipt in the same transaction — bytes gone, key gone, hash and size recorded', async () => {
    const original = Buffer.from(`original-${RUN}-` + 'x'.repeat(500));
    const { url, sha256, doc } = await storedDocument(original, new Date(Date.now() - 86_400_000));
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    const purged = await system(() => service.purgeDocumentNow({ ...doc, user: { tenantId: 'swift-default' } }, 'reaper', { requireRetentionElapsed: true, shredFields: false }));
    expect(purged).toBe('PURGED');
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
    const source = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: url } });
    expect(receipt.storeLocations).toEqual([`storage:${url}`, `encrypted_object:${source.sourceId}`]);
    await expect(storage.getObject(url)).rejects.toThrow();
    const envelope = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: url } });
    expect(envelope.wrappedDek).toBeNull();
    expect(envelope.shreddedAt).toBeInstanceOf(Date);
    // A second sweep finds nothing due for this document: exactly one receipt.
    expect(await system(() => service.purgeDocumentNow({ ...doc, user: { tenantId: 'swift-default' } }, 'reaper', { requireRetentionElapsed: true, shredFields: false }))).toBe('NOT_PURGED');
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: doc.id } }))).toBe(1);
  });

  it('a store that keeps the bytes yields a FAILED attempt event and no successful receipt', async () => {
    const original = Buffer.from(`sticky-${RUN}`);
    const { sha256, doc } = await storedDocument(original, new Date(Date.now() + 86_400_000));
    const sticky: StorageProvider = {
      purgeNamespace: storage.purgeNamespace,
      upload: storage.upload.bind(storage),
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: async () => undefined,
      getObject: async () => original,
    };
    const claim = await system(() => claimDocumentPurge(app.prisma, sticky, { documentId: doc.id, userId, tenantId: 'swift-default', mode: 'FULL_RETENTION', initiatedBy: 'reaper' }));
    const evidence = await system(() => probeCommittedPurge(app.prisma, sticky, claim!.id, 'swift-default'));
    expect(evidence.probe).toBe('FAILED');
    expect(evidence.sha256 && Buffer.from(evidence.sha256).toString('hex')).toBe(sha256);
    expect(Number(evidence.bytesDeleted)).toBe(original.length);
    expect(await system(() => finishDocumentPurge(app.prisma, claim!.id, 'swift-default', evidence, async () => undefined))).toBe('PROBE_FAILED');
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: doc.id } }))).toBe(0);
    expect(await system(() => app.prisma.documentPurgeEvent.count({ where: { claimId: claim!.id, kind: 'PROBE_FAILED' } }))).toBe(1);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).purgedAt).toBeNull();
  });

  it('the reaper leaves a FAILED row due (never marks it purged), and every purge writer writes a receipt — a census', () => {
    const service = readFileSync(join(API_SRC, 'modules', 'verification', 'purge-fence.ts'), 'utf8');
    // [P25] The one purge of one document is purgeDocumentNow: a FAILED probe writes its receipt and returns before anything is marked purged.
    expect(service).toMatch(/if \(evidence\.probe === 'FAILED'\) return 'PROBE_FAILED'/);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules'].includes(name)) walk(p, out); continue; }
        if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    // `purgedAt` is also a StorageOrphan field: only files that write verification documents count.
    const writers = walk(API_SRC).filter((file) => {
      const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      let writes = false;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['update', 'updateMany'].includes(node.expression.name.text)
          && ts.isPropertyAccessExpression(node.expression.expression)
          && node.expression.expression.name.text === 'verificationDocument') {
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            const data = arg.properties.find((v) => ts.isPropertyAssignment(v) && v.name.getText(tree) === 'data');
            if (data && ts.isPropertyAssignment(data) && /\bpurgedAt\s*:/.test(data.initializer.getText(tree))) writes = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      return writes;
    });
    for (const f of writers) {
      expect(readFileSync(f, 'utf8'), `${relative(API_SRC, f)} marks documents purged without a receipt`).toMatch(/writeDeletionReceipt\(/);
    }
    expect(writers.map((f) => relative(API_SRC, f)).sort()).toEqual(['modules/verification/purge-fence.ts']);
  });

  it('receipts are append-only: no update, no delete', async () => {
    const receipt = await system(() => app.prisma.deletionReceipt.findFirstOrThrow({ where: { subjectId: userId } }));
    await expect(system(() => app.prisma.deletionReceipt.update({ where: { id: receipt.id }, data: { verificationProbeResult: 'CONFIRMED_ABSENT' } }))).rejects.toThrow(/append-only/);
    await expect(system(() => app.prisma.deletionReceipt.delete({ where: { id: receipt.id } }))).rejects.toThrow(/append-only/);
    await expect(app.prisma.$executeRaw(Prisma.sql`DELETE FROM deletion_receipt WHERE id = ${receipt.id}::uuid`)).rejects.toThrow(/append-only/);
  });
});
