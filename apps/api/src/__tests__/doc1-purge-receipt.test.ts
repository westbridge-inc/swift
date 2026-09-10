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
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import {
  acquireVerificationUploads,
  authorizeVerificationPurge,
  consumeVerificationUploads,
  createVerificationUpload,
  deleteAuthorizedVerificationUploads,
} from '../modules/verification/verification-upload';
import { hopDocState } from '../modules/verification/doc-state';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const API_SRC = join(__dirname, '..');
let app: FastifyInstance;
let userId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-purge-receipt-test');
const storage = new LocalStorageProvider();

async function storedDocument(original: Buffer, retentionExpiresAt: Date) {
  const uploaded = await createVerificationUpload(app.prisma, storage, { error: () => undefined }, {
    userId,
    purpose: 'CHECKLIST_DOCUMENT',
    roleKey: 'MOVER',
    docType: 'national_id',
    buffer: original,
    filename: `doc-${nanoid(6)}.jpg`,
    mimeType: 'image/jpeg',
  });
  const authority = await acquireVerificationUploads(app.prisma, userId, [{
    uploadId: uploaded.uploadId,
    purpose: 'CHECKLIST_DOCUMENT',
    roleKey: 'MOVER',
    docType: 'national_id',
  }]);
  const claim = authority.claims[0]!;
  const doc = await app.prisma.$transaction(async (tx) => {
    const created = await tx.verificationDocument.create({
      data: {
        userId,
        role: 'MOVER',
        docType: 'national_id',
        verificationRoleKey: 'MOVER',
        fileUrl: claim.providerKey,
        status: 'PENDING',
        state: 'CAPTURED',
        retentionExpiresAt,
      },
    });
    await tx.extractionRun.create({ data: {
      submissionId: created.id,
      tenantId: 'swift-default',
      profileCode: 'TEST',
      engineName: 'test',
      engineVersion: '1',
      startedAt: new Date(),
      outcome: 'OK',
    } });
    await consumeVerificationUploads(tx, {
      userId,
      processingId: authority.processingId,
      uploadIds: [claim.id],
      submissionId: created.id,
    });
    await tx.verificationDocument.update({
      where: { id: created.id },
      data: { storageProvenance: 'VERIFIED' },
    });
    await hopDocState(tx, { id: created.id }, 'CAPTURED', 'PREPROCESSED');
    await hopDocState(tx, { id: created.id }, 'PREPROCESSED', 'EXTRACTING');
    await hopDocState(tx, { id: created.id }, 'EXTRACTING', 'EXTRACTED');
    await hopDocState(tx, { id: created.id }, 'EXTRACTED', 'VALIDATED');
    await hopDocState(tx, { id: created.id }, 'VALIDATED', 'AUTO_APPROVED');
    await hopDocState(tx, { id: created.id }, 'AUTO_APPROVED', 'COMMITTED');
    return tx.verificationDocument.findUniqueOrThrow({ where: { id: created.id } });
  });
  return {
    url: claim.providerKey,
    objectVersion: claim.objectVersion,
    storageLocationId: claim.storageLocationId,
    sha256: claim.sha256,
    doc,
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();
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
  await app.close();
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
});

describe('[DOC-INV-7] proof of purge', () => {
  it('the reaper purges a due document and writes a CONFIRMED_ABSENT receipt in the same transaction — bytes gone, key gone, hash and size recorded', async () => {
    const original = Buffer.from(`original-${RUN}-` + 'x'.repeat(500));
    const { url, objectVersion, storageLocationId, sha256, doc } = await storedDocument(original, new Date(Date.now() - 86_400_000));
    const run = await system(() => app.prisma.extractionRun.create({ data: {
      submissionId: doc.id,
      tenantId: 'swift-default',
      profileCode: 'TEST',
      engineName: 'test',
      engineVersion: '1',
      startedAt: new Date(),
      outcome: 'OK',
      wrappedDek: Buffer.from('wrapped-derived-key'),
      fields: { create: {
        tenantId: 'swift-default',
        submissionId: doc.id,
        fieldCode: 'doc_number',
        valueCt: Buffer.from('encrypted-derived-value'),
        valueBlind: `blind-${RUN}`,
        source: 'PROVIDER',
      } },
    } }));
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
    expect(receipt.storeLocations).toEqual([
      `object:v1:${storageLocationId.length}:${storageLocationId}:${url.length}:${url}:${objectVersion.length}:${objectVersion}`,
      `envelope:${url}`,
    ]);
    await expect(storage.getObject(url)).rejects.toThrow();
    const envelope = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: url } });
    expect(envelope.wrappedDek).toBeNull();
    expect(envelope.shreddedAt).toBeInstanceOf(Date);
    const shreddedRun = await system(() => app.prisma.extractionRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { fields: true },
    }));
    expect(shreddedRun.wrappedDek).toBeNull();
    expect(shreddedRun.fields).toHaveLength(1);
    expect(shreddedRun.fields[0]).toMatchObject({ valueCt: null, valueBlind: null });
    expect(row.storagePurgeMode).toBe('FULL_RETENTION');
    // A second sweep finds nothing due for this document: exactly one receipt.
    await system(() => service.purgeExpiredDocuments());
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: doc.id } }))).toBe(1);
  });

  it('a store that keeps the bytes yields a FAILED probe — and a FAILED receipt says so', async () => {
    const original = Buffer.from(`sticky-${RUN}`);
    const { url, doc } = await storedDocument(original, new Date(Date.now() + 86_400_000));
    const sticky: StorageProvider = {
      locationId: storage.locationId.bind(storage),
      exactDeleteCapability: storage.exactDeleteCapability.bind(storage),
      reserveKey: storage.reserveKey.bind(storage),
      upload: storage.upload.bind(storage),
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: async () => undefined,
      deleteExact: async () => undefined,
      getObject: async () => original,
      probe: async () => 'PRESENT',
      identifyGeneration: storage.identifyGeneration.bind(storage),
    };
    const authority = await system(() => authorizeVerificationPurge(app.prisma, {
      documentId: doc.id,
      userId,
      mode: 'FULL_RETENTION',
      requestedBy: 'reaper',
      requireRetentionElapsed: false,
    }));
    const evidence = await system(() => deleteAuthorizedVerificationUploads(
      app.prisma, { error: () => undefined }, authority, () => sticky,
    ));
    expect(evidence.probe).toBe('FAILED');
    expect(evidence.bytesDeleted).toBe(0n);
    const receipt = await system(() => app.prisma.deletionReceipt.findFirstOrThrow({
      where: { submissionId: doc.id },
      orderBy: { deletedAt: 'desc' },
    }));
    expect(receipt.verificationProbeResult).toBe('FAILED');
    // the real store still has the object (the spy never deleted it); clean it
    await storage.delete(url);
  });

  it('the reaper leaves a FAILED row due (never marks it purged), and every purge writer writes a receipt — a census', () => {
    const service = readFileSync(join(API_SRC, 'modules', 'verification', 'verification.service.ts'), 'utf8');
    const authority = readFileSync(join(API_SRC, 'modules', 'verification', 'verification-upload.ts'), 'utf8');
    // [P25] The authority seam persists a FAILED attempt before callers return
    // without finalizing any purge marker.
    expect(authority).toMatch(/if \(!allAbsent\) \{[\s\S]*await writeDeletionReceipt\(db,/);
    expect(service).toMatch(/if \(evidence\.probe === 'FAILED'\) return 'PROBE_FAILED';/);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules'].includes(name)) walk(p, out); continue; }
        if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    // `purgedAt` is also a StorageOrphan field: only files that write verification documents count.
    const writers = walk(API_SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /verificationDocument\.(?:update|updateMany)\([\s\S]{0,1200}(?:purgedAt|imagePurgedAt):\s*(?:new Date\(\)|now)/.test(src);
    });
    for (const f of writers) {
      expect(readFileSync(f, 'utf8'), `${relative(API_SRC, f)} marks documents purged without a receipt`).toMatch(/writeDeletionReceipt\(/);
    }
    expect(writers.map((f) => relative(API_SRC, f)).sort()).toEqual(['modules/verification/verification-upload.ts']);
  });

  it('receipts are append-only: no update, no delete', async () => {
    const receipt = await system(() => app.prisma.deletionReceipt.findFirstOrThrow({ where: { subjectId: userId } }));
    await expect(system(() => app.prisma.deletionReceipt.update({ where: { id: receipt.id }, data: { verificationProbeResult: 'CONFIRMED_ABSENT' } }))).rejects.toThrow(/append-only/);
    await expect(system(() => app.prisma.deletionReceipt.delete({ where: { id: receipt.id } }))).rejects.toThrow(/append-only/);
    await expect(app.prisma.$executeRaw(Prisma.sql`DELETE FROM deletion_receipt WHERE id = ${receipt.id}::uuid`)).rejects.toThrow(/append-only/);
  });
});
