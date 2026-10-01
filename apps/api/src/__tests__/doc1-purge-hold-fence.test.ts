import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { VerificationService } from '../modules/verification/verification.service';
import { placeDocLegalHold, releaseDocLegalHold } from '../modules/verification/legal-hold';
import { AccountService } from '../modules/user/account.service';
import type { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

import { claimDocumentPurge, probeCommittedPurge, finishDocumentPurge, purgeUnattachedObject, assertCompleteSourceCensus } from '../modules/verification/purge-fence';
import { documentMaintenanceScope } from './helpers/document-maintenance-scope';
import { runWithTenant } from '../plugins/tenant-context';
import { retryStorageOrphan } from '../lib/storage-orphans';
import { eraseDocumentsFor, exportDocumentsFor } from '../modules/verification/dsar';
import { resolveVerificationObject } from '../modules/verification/object-authority';
import { backfillSubjects } from '../modules/verification/subjects';
import { getStorageProvider } from '../providers/storage/storage-provider';

// Only the external storage boundary is synthetic. Reads, locks, hold commits,
// envelope shredding, extracted values and receipts use two real DB connections.
const synthetic = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  deleted: [] as string[],
  beforeRead: undefined as undefined | ((key: string) => Promise<void>),
}));
vi.mock('../providers/storage/storage-provider', async (original) => ({
  ...await original<object>(),
  getStorageProvider: () => ({
    purgeNamespace: async () => 'synthetic:hold-fence',
    upload: async () => { throw new Error('This test does not upload'); },
    getSignedUrl: async () => { throw new Error('This test does not render'); },
    delete: async (key: string) => { synthetic.deleted.push(key); synthetic.objects.delete(key); },
    getObject: async (key: string) => {
      await synthetic.beforeRead?.(key);
      const bytes = synthetic.objects.get(key);
      if (!bytes) throw Object.assign(new Error('Synthetic object absent'), { code: 'ENOENT' });
      return bytes;
    },
  }),
}));

const worker = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
const holder = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
const DAY = 86_400_000;
const notifications = { send: vi.fn(async () => undefined) } as unknown as NotificationService;
const service = (db: PrismaClient) => new VerificationService(db, notifications, new SandboxKycProvider());

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture() {
  const id = `holdfence-${randomUUID()}`;
  const user = await worker.user.create({ data: {
    id, phone: `synthetic:${id}`, firstName: 'Synthetic', lastName: 'HoldFence',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE',
  } });
  const fileKey = `/uploads/verification/${id}/source.enc`;
  const bytes = Buffer.from('Synthetic document bytes, no personal data');
  synthetic.objects.set(fileKey, bytes);
  const envelope = await worker.encryptedObject.create({ data: {
    fileKey, storageNamespace: 'synthetic:hold-fence', createdBy: id, iv: new Uint8Array(12).fill(1), authTag: new Uint8Array(16).fill(2),
    wrappedDek: new Uint8Array(40).fill(3), sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: 'image/jpeg', sizeBytes: bytes.length,
  } });
  const doc = await worker.verificationDocument.create({ data: {
    userId: id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: fileKey,
    status: 'APPROVED', retentionExpiresAt: new Date(Date.now() - DAY),
  } });
  const extraction = await worker.extractionRun.create({ data: {
    submissionId: doc.id, tenantId: user.tenantId, profileCode: 'SYNTHETIC',
    engineName: 'synthetic', engineVersion: '1', startedAt: new Date(), outcome: 'OK',
    wrappedDek: new Uint8Array(40).fill(4),
    fields: { create: {
      submissionId: doc.id, tenantId: user.tenantId, fieldCode: 'synthetic_field',
      valueCt: new Uint8Array(40).fill(5), source: 'HUMAN',
    } },
  } });
  return { user, doc, envelope, extraction, bytes, fileKey };
}

beforeAll(async () => {
  // Pin a connection in each pool simultaneously: this cannot be a single
  // connection pretending to exercise transaction ordering.
  await worker.$transaction(async (tx) => {
    const [a] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const [b] = await holder.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    expect(a!.pid).not.toBe(b!.pid);
  });
});
afterEach(() => { synthetic.beforeRead = undefined; });
afterAll(async () => {
  // These synthetic custody/hold records are retained; no broad cleanup can
  // remove the evidence of a failed race or rewrite an append-only receipt.
  await Promise.all([worker.$disconnect(), holder.$disconnect()]);
});

describe('committed legal hold wins before irreversible document purge', () => {
  it.each(['IMAGE_ONLY', 'RETENTION', 'ERASURE', 'ACCOUNT'] as const)(
    '%s: hold commits after candidate read; bytes, both DEKs and values survive',
    async (mode) => {
      const f = await fixture();
      const selected = barrier();
      const resume = barrier();
      let paused = false;
      const gated = worker.$extends({ query: { verificationDocument: {
        async $allOperations({ operation, args, query }) {
          const result = await query(args);
          const candidate = operation === 'findUnique'
            ? mode === 'IMAGE_ONLY' && (result as { id?: string } | null)?.id === f.doc.id
            : operation === 'findMany' && mode !== 'IMAGE_ONLY'
              && Array.isArray(result) && result.some((row: { id?: string }) => row.id === f.doc.id);
          if (candidate && !paused) {
            paused = true;
            selected.release();
            await resume.promise;
          }
          return result;
        },
      } } }) as unknown as PrismaClient;
      const run = async () => {
        if (mode === 'IMAGE_ONLY') return service(gated).purgeImageAfterReview(f.doc.id, 'synthetic-test');
        if (mode === 'RETENTION') return service(documentMaintenanceScope(gated, [f.user.id])).purgeExpiredDocuments();
        if (mode === 'ACCOUNT') {
          const app = {
            prisma: gated,
            io: { in: () => ({ disconnectSockets: () => undefined }) },
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          } as unknown as FastifyInstance;
          return new AccountService(app).deleteAccount(f.user.id);
        }
        const [candidate] = await gated.verificationDocument.findMany({
          where: { id: f.doc.id },
          select: { id: true, userId: true, fileUrl: true, docType: true, user: { select: { tenantId: true } } },
        });
        return service(gated).purgeDocumentNow(candidate!, f.user.id, { requireRetentionElapsed: false, shredFields: true });
      };
      // Attach a rejection observer immediately, including if a regression
      // makes the worker fail before the candidate barrier.
      const work = run();
      const settled = work.then((value) => ({ value }), (error: unknown) => ({ error }));
      let holdId = '';
      let holdError: unknown;
      try {
        const reached = await Promise.race([
          selected.promise.then(() => true), settled.then(() => false),
        ]);
        expect(reached, 'worker must reach the stale-candidate boundary').toBe(true);
        const placed = await placeDocLegalHold(holder, {
          subjectUserId: f.user.id, documentIds: [f.doc.id], reason: 'Synthetic hold-first race',
          ownerId: f.user.id, placedBy: f.user.id, reviewBy: new Date(Date.now() + 7 * DAY),
        });
        holdId = placed.hold.id;
        expect(placed.documents).toBe(1);
        // This independent read occurs after the holding transaction returns.
        expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).legalHoldId).toBe(holdId);
      } catch (error) {
        holdError = error;
      } finally {
        resume.release();
      }
      const outcome = await settled;
      if (holdError) throw holdError;
      expect.soft(outcome).not.toHaveProperty('error');
      if (mode === 'ACCOUNT' && 'value' in outcome) expect(outcome.value).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
      const document = await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } });
      const object = await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: f.fileKey } });
      const extraction = await holder.extractionRun.findUniqueOrThrow({ where: { id: f.extraction.id }, include: { fields: true } });
      // Counts/booleans only: never print document contents or envelope bytes.
      // eslint-disable-next-line no-console
      console.info('[hold-first-observation]', JSON.stringify({
        mode, holdCommitted: document.legalHoldId === holdId,
        storageDeleteCalled: synthetic.deleted.includes(f.fileKey),
        imagePresent: synthetic.objects.has(f.fileKey), imageDekPresent: object.wrappedDek !== null,
        fieldDekPresent: extraction.wrappedDek !== null, fieldValuePresent: extraction.fields[0]!.valueCt !== null,
        workerThrew: 'error' in outcome,
      }));
      // Soft assertions preserve the whole hazard signature on old source.
      expect.soft(synthetic.deleted).not.toContain(f.fileKey);
      expect.soft(synthetic.objects.get(f.fileKey)).toEqual(f.bytes);
      expect.soft(object.wrappedDek).toEqual(f.envelope.wrappedDek);
      expect.soft(object.shreddedAt).toBeNull();
      expect.soft(document).toMatchObject({ legalHoldId: holdId, fileUrl: f.fileKey, purgedAt: null, imagePurgedAt: null });
      expect.soft(extraction.wrappedDek).toEqual(f.extraction.wrappedDek);
      expect.soft(extraction.fields[0]!.valueCt).toEqual(new Uint8Array(40).fill(5));
      expect.soft(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id, verificationProbeResult: 'CONFIRMED_ABSENT' } })).toBe(0);
    },
  );
});

describe('purge authority must commit before the storage boundary', () => {
  it.each(['IMAGE_ONLY', 'ERASURE'] as const)(
    '%s: a hold after storage work begins must explicitly conflict, never report preservation',
    async (mode) => {
      const f = await fixture();
      const enteredStorage = barrier();
      const resume = barrier();
      let paused = false;
      synthetic.beforeRead = async (key) => {
        if (key === f.fileKey && !paused) {
          paused = true;
          enteredStorage.release();
          await resume.promise;
        }
      };
      const purge = mode === 'IMAGE_ONLY'
        ? service(worker).purgeImageAfterReview(f.doc.id, 'synthetic-test')
        : service(worker).purgeDocumentNow({ ...f.doc, user: { tenantId: f.user.tenantId } }, f.user.id, {
          requireRetentionElapsed: false, shredFields: true,
        });
      const settled = purge.then((value) => ({ value }), (error: unknown) => ({ error }));
      let holdResult: unknown;
      let holdError: unknown;
      try {
        const reached = await Promise.race([
          enteredStorage.promise.then(() => true), settled.then(() => false),
        ]);
        expect(reached, 'worker must traverse the actual storage boundary').toBe(true);
        try {
          holdResult = await placeDocLegalHold(holder, {
            subjectUserId: f.user.id, documentIds: [f.doc.id], reason: 'Synthetic purge-first race',
            ownerId: f.user.id, placedBy: f.user.id, reviewBy: new Date(Date.now() + 7 * DAY),
          });
        } catch (error) {
          holdError = error;
        }
      } finally {
        resume.release();
        await settled;
        synthetic.beforeRead = undefined;
      }
      // eslint-disable-next-line no-console
      console.info('[purge-first-observation]', JSON.stringify({
        mode, storageBoundaryTraversed: paused, holdReportedSuccess: holdResult !== undefined,
        holdErrorCode: (holdError as { code?: string } | undefined)?.code ?? null,
      }));
      expect.soft(holdResult).toBeUndefined();
      expect(holdError).toMatchObject({ statusCode: 409, code: 'DOCUMENT_PURGE_COMMITTED' });
    },
  );
});

async function claimFixture(mode: 'IMAGE_ONLY' | 'FULL_RETENTION' | 'FULL_ERASURE' = 'FULL_ERASURE') {
  const f = await fixture();
  const claim = await claimDocumentPurge(worker, getStorageProvider(), {
    documentId: f.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode, initiatedBy: 'synthetic-test',
  });
  expect(claim).not.toBeNull();
  return { ...f, claim: claim! };
}
const holdInput = (f: Awaited<ReturnType<typeof fixture>>) => ({
  subjectUserId: f.user.id, documentIds: [f.doc.id], reason: 'Synthetic preservation', ownerId: f.user.id,
  placedBy: f.user.id, reviewBy: new Date(Date.now() + 7 * DAY),
});
const finish = (f: Awaited<ReturnType<typeof claimFixture>>, evidence: Awaited<ReturnType<typeof probeCommittedPurge>>) =>
  finishDocumentPurge(worker, f.claim.id, f.user.tenantId, evidence, service(worker).projectDocumentPurge.bind(service(worker)));

describe('durable exact-source authority and recovery', () => {
  it('committed authority is visible on the independent connection before storage; no transaction holds the user lock', async () => {
    const f = await fixture();
    let crossed = false;
    synthetic.beforeRead = async (key) => {
      if (key !== f.fileKey || crossed) return;
      crossed = true;
      const claim = await holder.documentPurgeClaim.findFirstOrThrow({ where: { documentId: f.doc.id } });
      expect(claim.state).toBe('COMMITTED');
      await holder.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${f.user.id} FOR UPDATE`;
      });
    };
    expect(await service(worker).purgeDocumentNow({ ...f.doc, user: f.user }, f.user.id, { requireRetentionElapsed: false, shredFields: true })).toBe('PURGED');
    expect(crossed).toBe(true);
    const receipt = await holder.deletionReceipt.findFirstOrThrow({ where: { submissionId: f.doc.id } });
    expect(receipt).toMatchObject({ verificationProbeResult: 'CONFIRMED_ABSENT', scope: 'FULL_ERASURE' });
    expect(receipt.purgeClaimId).not.toBeNull();
  });

  it('a rolled back claim cannot reach storage or shred keys', async () => {
    const f = await fixture();
    const failing = worker.$extends({ query: { documentPurgeEvent: { async create() { throw new Error('synthetic before-commit crash'); } } } }) as unknown as PrismaClient;
    await expect(service(failing).purgeDocumentNow({ ...f.doc, user: f.user }, f.user.id, { requireRetentionElapsed: false, shredFields: true })).rejects.toThrow('synthetic before-commit crash');
    expect(synthetic.deleted).not.toContain(f.fileKey);
    expect(await holder.documentPurgeClaim.count({ where: { documentId: f.doc.id } })).toBe(0);
    expect((await placeDocLegalHold(holder, holdInput(f))).documents).toBe(1);
  });

  it('uncommitted transaction-local authority cannot be sent to the external worker', async () => {
    const f = await claimFixture();
    await worker.$transaction(async (tx) => {
      await expect(probeCommittedPurge(tx as PrismaClient, getStorageProvider(), f.claim.id, f.user.tenantId)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    });
    expect(synthetic.deleted).not.toContain(f.fileKey);
  });

  it.each(['before-delete', 'after-delete', 'after-key', 'before-completion'] as const)('crash %s leaves permanent authority, conflict and exactly one eventual receipt', async (point) => {
    const f = await claimFixture();
    if (point === 'after-delete') {
      await getStorageProvider().delete(f.fileKey); // actual synthetic side-effect, then crash before key step
    } else if (point === 'after-key' || point === 'before-completion') {
      const evidence = await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId);
      expect(evidence.probe).toBe('CONFIRMED_ABSENT');
    }
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(0);
    await expect(placeDocLegalHold(holder, holdInput(f))).rejects.toMatchObject({ code: 'DOCUMENT_PURGE_COMMITTED' });
    const evidence = await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId);
    expect(await finish(f, evidence)).toBe('PURGED');
    expect(await finish(f, evidence)).toBe('PURGED');
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(1);
    expect((await holder.extractionRun.findUniqueOrThrow({ where: { id: f.extraction.id }, include: { fields: true } }))).toMatchObject({ wrappedDek: null, fields: [{ valueCt: null }] });
  });

  it.each(['readable', 'unknown-probe'] as const)('%s never certifies absence; exact already-shredded retry succeeds', async (failure) => {
    const f = await claimFixture();
    let reads = 0;
    const store = getStorageProvider();
    const broken = {
      ...store,
      delete: failure === 'readable' ? async () => undefined : store.delete,
      getObject: async (key: string) => {
        reads += 1;
        if (failure === 'unknown-probe' && reads >= 2) throw new Error('synthetic unknown provider response');
        return store.getObject(key);
      },
    };
    const evidence = await probeCommittedPurge(worker, broken, f.claim.id, f.user.tenantId);
    expect(evidence.probe).toBe('FAILED');
    expect(await finish(f, evidence)).toBe('PROBE_FAILED');
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(0);
    expect((await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: f.fileKey } })).wrappedDek).toBeNull();
    await expect(placeDocLegalHold(holder, holdInput(f))).rejects.toMatchObject({ code: 'DOCUMENT_PURGE_COMMITTED' });
    expect(await finish(f, await probeCommittedPurge(worker, store, f.claim.id, f.user.tenantId))).toBe('PURGED');
  });

  it('old image worker after acknowledged remaining-data hold cannot erase fields or duplicate receipts', async () => {
    const f = await claimFixture('IMAGE_ONLY');
    const evidence = await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId);
    expect(await finish(f, evidence)).toBe('PURGED');
    await expect(placeDocLegalHold(holder, holdInput(f))).rejects.toMatchObject({ code: 'DOCUMENT_IMAGE_ALREADY_PURGED' });
    const held = await placeDocLegalHold(holder, { ...holdInput(f), preserveRemainingData: true });
    expect(held).toMatchObject({ scope: 'REMAINING_DATA', missingImageDocumentIds: [f.doc.id] });
    expect(held.priorReceiptIds).toHaveLength(1);
    // No timeout or lease is consulted. A delayed worker retains IMAGE_ONLY scope.
    expect(await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId))).toBe('PURGED');
    expect((await holder.extractionRun.findUniqueOrThrow({ where: { id: f.extraction.id } })).wrappedDek).not.toBeNull();
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(1);
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).legalHoldId).toBe(held.hold.id);
  });

  it.each(['IMAGE_ONLY', 'FULL_RETENTION'] as const)('%s completion requires a separate full-erasure claim for remaining fields', async (mode) => {
    const f = await claimFixture(mode);
    await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId));
    const next = await claimDocumentPurge(worker, getStorageProvider(), { documentId: f.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_ERASURE', initiatedBy: 'synthetic-test' });
    expect(next).toMatchObject({ mode: 'FULL_ERASURE', sourceKind: 'PRIOR_IMAGE', previousImageClaimId: f.claim.id });
    expect(next!.id).not.toBe(f.claim.id);
    expect(await finish({ ...f, claim: next! }, await probeCommittedPurge(worker, getStorageProvider(), next!.id, f.user.tenantId))).toBe('PURGED');
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).fieldsPurgedAt).not.toBeNull();
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(2);
  });

  it('competing modes never widen the winner, and account deletion does not silently upgrade a late image worker', async () => {
    const f = await claimFixture('IMAGE_ONLY');
    await holder.user.update({ where: { id: f.user.id }, data: { phone: `deleted:${f.user.id}` } });
    const next = await claimDocumentPurge(worker, getStorageProvider(), { documentId: f.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_ERASURE', initiatedBy: 'synthetic-test' });
    expect(next).toBeNull();
    await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId));
    expect((await holder.extractionRun.findUniqueOrThrow({ where: { id: f.extraction.id } })).wrappedDek).not.toBeNull();
  });

  it('namespace and tenant mismatch refuse before any external effect', async () => {
    const f = await claimFixture();
    await expect(probeCommittedPurge(worker, { ...getStorageProvider(), purgeNamespace: async () => 'synthetic:another-namespace' }, f.claim.id, f.user.tenantId)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    await expect(probeCommittedPurge(worker, getStorageProvider(), f.claim.id, 'wrong-tenant')).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(synthetic.deleted).not.toContain(f.fileKey);
  });

  it('hold batch rejects missing IDs atomically and racing releases preserve the first provenance', async () => {
    const f = await fixture();
    await expect(placeDocLegalHold(holder, { ...holdInput(f), documentIds: [f.doc.id, 'missing-synthetic-document'] })).rejects.toMatchObject({ code: 'DOCUMENTS_NOT_FOUND' });
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).legalHoldId).toBeNull();
    const placed = await placeDocLegalHold(holder, holdInput(f));
    const outcomes = await Promise.allSettled([
      releaseDocLegalHold(worker, { holdId: placed.hold.id, releasedBy: 'synthetic-a', reason: 'first contender' }),
      releaseDocLegalHold(holder, { holdId: placed.hold.id, releasedBy: 'synthetic-b', reason: 'second contender' }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await holder.documentPurgeEvent.count({ where: { holdId: placed.hold.id, kind: 'HOLD_RELEASED' } })).toBe(1);
  });

  it('hold conflict is immutable and cannot be erased with its claim or completion receipt', async () => {
    const f = await claimFixture();
    await expect(placeDocLegalHold(holder, holdInput(f))).rejects.toMatchObject({ code: 'DOCUMENT_PURGE_COMMITTED' });
    const event = await holder.documentPurgeEvent.findFirstOrThrow({ where: { claimId: f.claim.id, kind: 'HOLD_CONFLICT_PURGE_COMMITTED' } });
    await expect(holder.documentPurgeEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(holder.documentPurgeClaim.delete({ where: { id: f.claim.id } })).rejects.toThrow();
    await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId));
    const receipt = await holder.deletionReceipt.findUniqueOrThrow({ where: { purgeClaimId: f.claim.id } });
    await expect(holder.deletionReceipt.update({ where: { id: receipt.id }, data: { verificationProbeResult: 'FAILED' } })).rejects.toThrow();
  });
});

describe('database bypass barriers', () => {
  it('a hold protects raw keys, values, pointers, identity and cascade deletes', async () => {
    const f = await fixture();
    await placeDocLegalHold(holder, holdInput(f));
    for (const action of [
      () => worker.$executeRaw`UPDATE encrypted_objects SET "wrappedDek" = NULL WHERE "fileKey" = ${f.fileKey}`,
      () => worker.$executeRaw`UPDATE extraction_run SET "wrappedDek" = NULL WHERE id = ${f.extraction.id}::uuid`,
      () => worker.$executeRaw`UPDATE extracted_field SET "valueCt" = NULL WHERE "submissionId" = ${f.doc.id}`,
      () => worker.$executeRaw`UPDATE verification_documents SET "fileUrl" = '' WHERE id = ${f.doc.id}`,
      () => worker.$executeRaw`UPDATE verification_documents SET "legalHoldId" = NULL WHERE id = ${f.doc.id}`,
      () => worker.$executeRaw`DELETE FROM verification_documents WHERE id = ${f.doc.id}`,
      () => worker.$executeRaw`DELETE FROM users WHERE id = ${f.user.id}`,
    ]) await expect(action()).rejects.toThrow();
    expect((await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: f.fileKey } })).wrappedDek).not.toBeNull();
  });

  it('claim cannot rebind subject, envelope, namespace, mode, extraction membership or be revoked', async () => {
    const f = await claimFixture();
    for (const action of [
      () => worker.documentPurgeClaim.update({ where: { id: f.claim.id }, data: { mode: 'IMAGE_ONLY' } }),
      () => worker.verificationDocument.update({ where: { id: f.doc.id }, data: { subjectId: randomUUID() } }),
      () => worker.verificationDocument.update({ where: { id: f.doc.id }, data: { activePurgeClaimId: null } }),
      () => worker.encryptedObject.update({ where: { fileKey: f.fileKey }, data: { sha256: 'a'.repeat(64) } }),
      () => worker.encryptedObject.update({ where: { fileKey: f.fileKey }, data: { storageNamespace: 'synthetic:other' } }),
      () => worker.encryptedObject.delete({ where: { fileKey: f.fileKey } }),
      () => worker.extractedField.create({ data: { runId: f.extraction.id, submissionId: f.doc.id, tenantId: f.user.tenantId, fieldCode: 'late_field', source: 'HUMAN', valueCt: new Uint8Array([1]) } }),
    ]) await expect(action()).rejects.toThrow();
  });

  it('retirement blocks aliases, reattachment and envelope recreation after actual deletion', async () => {
    const f = await claimFixture();
    await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId));
    for (const key of [f.fileKey, f.fileKey.replace('/uploads/', ''), f.fileKey.replace('/source.enc', '/./source.enc')]) {
      await expect(worker.verificationDocument.create({ data: { userId: f.user.id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: key } })).rejects.toThrow();
      await expect(worker.encryptedObject.create({ data: { fileKey: key, createdBy: f.user.id, iv: new Uint8Array(12), authTag: new Uint8Array(16), wrappedDek: new Uint8Array(40), mimeType: 'image/jpeg', sizeBytes: 1, sha256: 'a'.repeat(64) } })).rejects.toThrow();
    }
  });
});

async function orphanFixture() {
  const f = await fixture();
  const fileKey = f.fileKey.replace('source.enc', 'unattached.enc');
  synthetic.objects.set(fileKey, f.bytes);
  await worker.encryptedObject.create({ data: {
    fileKey, createdBy: f.user.id, storageNamespace: 'synthetic:hold-fence',
    iv: new Uint8Array(12).fill(1), authTag: new Uint8Array(16).fill(2), wrappedDek: new Uint8Array(40).fill(3),
    sha256: createHash('sha256').update(f.bytes).digest('hex'), sizeBytes: f.bytes.length, mimeType: 'image/jpeg',
  } });
  const orphan = await worker.storageOrphan.create({ data: { key: fileKey, userId: f.user.id, tenantId: f.user.tenantId, reason: 'ERASURE_PURGE_PROBE_FAILED' } });
  return { ...f, fileKey, orphan };
}

describe('orphan and source attachment ordering', () => {
  it('unattached claim commits first; a late submission is refused and hold conflicts', async () => {
    const f = await orphanFixture();
    let crossed = false;
    synthetic.beforeRead = async (key) => {
      if (key !== f.fileKey || crossed) return;
      crossed = true;
      const claim = await holder.documentPurgeClaim.findFirstOrThrow({ where: { orphanId: f.orphan.id } });
      expect(claim.mode).toBe('UNATTACHED_OBJECT');
      await expect(holder.verificationDocument.create({ data: { userId: f.user.id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: f.fileKey } })).rejects.toThrow();
      await expect(placeDocLegalHold(holder, { ...holdInput(f), documentIds: undefined })).rejects.toMatchObject({ code: 'DOCUMENT_PURGE_COMMITTED' });
    };
    expect(await purgeUnattachedObject(worker, getStorageProvider(), f.orphan.id)).toBe(true);
    expect(crossed).toBe(true);
    expect((await holder.storageOrphan.findUniqueOrThrow({ where: { id: f.orphan.id } })).purgedAt).not.toBeNull();
  });

  it('submission first blocks an unattached claim; forged tenant and upload-in-progress also refuse', async () => {
    const f = await orphanFixture();
    await holder.verificationDocument.create({ data: { userId: f.user.id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: f.fileKey } });
    await expect(purgeUnattachedObject(worker, getStorageProvider(), f.orphan.id)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(synthetic.deleted).not.toContain(f.fileKey);
    const other = await orphanFixture();
    await holder.storageOrphan.update({ where: { id: other.orphan.id }, data: { tenantId: 'forged-synthetic-tenant' } });
    await expect(purgeUnattachedObject(worker, getStorageProvider(), other.orphan.id)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(synthetic.deleted).not.toContain(other.fileKey);
  });

  it('hold first preserves unattached source and orphan obligation', async () => {
    const f = await orphanFixture();
    await placeDocLegalHold(holder, holdInput(f));
    await expect(purgeUnattachedObject(worker, getStorageProvider(), f.orphan.id)).resolves.toBe(false);
    expect(synthetic.deleted).not.toContain(f.fileKey);
    expect((await holder.storageOrphan.findUniqueOrThrow({ where: { id: f.orphan.id } })).purgedAt).toBeNull();
  });
});

describe('probe integrity and tenant wall', () => {
  it('fabricated evidence cannot issue a successful receipt before an actual probe', async () => {
    const f = await claimFixture();
    await holder.encryptedObject.update({ where: { sourceId: f.envelope.sourceId }, data: { wrappedDek: null, shreddedAt: new Date() } });
    expect(synthetic.objects.has(f.fileKey)).toBe(true); // No storage probe has occurred.
    await expect(finish(f, { probe: 'CONFIRMED_ABSENT', sha256: null, bytesDeleted: 0n, storeLocations: [] })).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(0);
    const other = await claimFixture();
    const evidence = await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId);
    await expect(finish(other, evidence)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
  });

  it('real NOBYPASSRLS role has tenant-only ledger access, rejects foreign writes, and refuses a hidden ownership census', async () => {
    const f = await claimFixture();
    await worker.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'holdfence_probe_20260930') THEN CREATE ROLE holdfence_probe_20260930 NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await worker.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO holdfence_probe_20260930');
    await worker.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO holdfence_probe_20260930');
    await worker.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE holdfence_probe_20260930');
      const [role] = await tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await tx.$queryRaw`SELECT set_config('app.current_tenant', ${f.user.tenantId}, true)`;
      expect(await tx.documentPurgeClaim.count({ where: { id: f.claim.id } })).toBe(1);
      await tx.$queryRaw`SELECT set_config('app.current_tenant', 'other-synthetic-tenant', true)`;
      expect(await tx.documentPurgeClaim.count({ where: { id: f.claim.id } })).toBe(0);
    });
    await expect(worker.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE holdfence_probe_20260930');
      await tx.$queryRaw`SELECT set_config('app.current_tenant', 'other-synthetic-tenant', true)`;
      await tx.documentPurgeEvent.create({ data: { tenantId: f.user.tenantId, userId: f.user.id, claimId: f.claim.id, kind: 'FORGED', actorId: 'synthetic', details: {} } });
    })).rejects.toThrow();
    const rollback = new Error('synthetic RLS DDL rollback');
    await expect(worker.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE verification_documents ENABLE ROW LEVEL SECURITY');
      await tx.$executeRawUnsafe('SET LOCAL ROLE holdfence_probe_20260930');
      await tx.$queryRaw`SELECT set_config('app.current_tenant', ${f.user.tenantId}, true)`;
      await expect(assertCompleteSourceCensus(tx)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
      throw rollback;
    })).rejects.toBe(rollback);
  });
});

describe('individual authority guards', () => {
  it('request tenant mismatch refuses the root-client worker before storage', async () => {
    const f = await claimFixture();
    await expect(runWithTenant('other-synthetic-tenant', () => probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId))).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(synthetic.deleted).not.toContain(f.fileKey);
  });

  it('mismatched envelope snapshot refuses before destructive access', async () => {
    const f = await claimFixture();
    const drift = worker.$extends({ query: { encryptedObject: { async findUnique({ args, query }) {
      const row = await query(args);
      return row && row.sourceId === f.envelope.sourceId ? { ...row, sha256: 'e'.repeat(64) } : row;
    } } } }) as unknown as PrismaClient;
    await expect(probeCommittedPurge(drift, getStorageProvider(), f.claim.id, f.user.tenantId)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(synthetic.deleted).not.toContain(f.fileKey);
  });

  it('pending upload reservation cannot be claimed or attached', async () => {
    const f = await fixture();
    const fileKey = f.fileKey.replace('source.enc', 'pending.enc');
    await worker.encryptedObject.create({ data: {
      fileKey, createdBy: f.user.id, storageNamespace: 'synthetic:hold-fence', uploadState: 'PENDING',
      iv: new Uint8Array(12), authTag: new Uint8Array(16), wrappedDek: new Uint8Array(40),
      sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'image/jpeg',
    } });
    const orphan = await worker.storageOrphan.create({ data: { key: fileKey, userId: f.user.id, tenantId: f.user.tenantId, reason: 'ERASURE_PURGE_PROBE_FAILED' } });
    await expect(resolveVerificationObject(worker, { fileKey, userId: f.user.id })).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    await expect(purgeUnattachedObject(worker, getStorageProvider(), orphan.id)).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(synthetic.deleted).not.toContain(fileKey);
  });

  it('the same transaction cannot mint authority and null an image key', async () => {
    const f = await fixture();
    await expect(worker.$transaction(async (tx) => {
      // Intercept only transaction composition to try to use the pending claim
      // before the owning transaction commits. The SQL claim guard must refuse.
      const nested = { $transaction: async (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
      const claim = await claimDocumentPurge(nested, getStorageProvider(), { documentId: f.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_ERASURE', initiatedBy: 'synthetic' });
      expect(claim).not.toBeNull();
      await tx.encryptedObject.update({ where: { sourceId: f.envelope.sourceId }, data: { wrappedDek: null, shreddedAt: new Date() } });
    })).rejects.toThrow();
    expect((await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: f.fileKey } })).wrappedDek).not.toBeNull();
    expect(await holder.documentPurgeClaim.count({ where: { documentId: f.doc.id } })).toBe(0);
  });
});

describe('account uploads and crash boundaries', () => {
  const account = () => new AccountService({ prisma: worker,
    io: { in: () => ({ disconnectSockets: () => undefined }) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyInstance);
  it('account deletion erases an unsubmitted upload through its own committed claim', async () => {
    const f = await orphanFixture();
    const result = await account().deleteAccount(f.user.id);
    expect(result).toMatchObject({ deleted: true });
    expect(synthetic.objects.has(f.fileKey)).toBe(false);
    const claim = await holder.documentPurgeClaim.findFirstOrThrow({ where: { fileKey: f.fileKey } });
    expect(claim).toMatchObject({ mode: 'UNATTACHED_OBJECT', state: 'COMPLETE' });
    expect((await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: f.fileKey } })).wrappedDek).toBeNull();
  });
  it('account deletion keeps an unfinished upload pending and fences new reservations after cutoff', async () => {
    const f = await fixture(); const key = f.fileKey.replace('source.enc', 'pending.enc');
    const metadata = { ...f.envelope, sourceId: undefined, fileKey: undefined };
    await worker.encryptedObject.create({ data: { ...metadata, fileKey: key, uploadState: 'PENDING' } });
    expect(await account().deleteAccount(f.user.id)).toMatchObject({ deleted: false, pendingVerificationObjects: 1 });
    expect(synthetic.deleted).not.toContain(key);
    await expect(holder.encryptedObject.create({ data: { ...metadata, fileKey: key.replace('pending', 'late') } })).rejects.toThrow('source owner unavailable');
    // The upload may finish after cutoff. Its permanent reservation becomes
    // recoverable only after the exact writer has finished; no expiring lease.
    synthetic.objects.set(key, f.bytes);
    await worker.encryptedObject.update({ where: { fileKey: key }, data: { uploadState: 'READY' } });
    expect(await account().deleteAccount(f.user.id)).toMatchObject({ deleted: true });
    expect(synthetic.objects.has(key)).toBe(false);
  });
  it('actual crash after storage delete leaves key intact and retries exact committed authority', async () => {
    const f = await claimFixture();
    const crashing = worker.$extends({ query: { encryptedObject: { async updateMany() { throw new Error('synthetic crash after delete'); } } } }) as unknown as PrismaClient;
    await expect(probeCommittedPurge(crashing, getStorageProvider(), f.claim.id, f.user.tenantId)).rejects.toThrow('synthetic crash after delete');
    expect(synthetic.objects.has(f.fileKey)).toBe(false);
    expect((await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: f.fileKey } })).wrappedDek).not.toBeNull();
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(0);
    expect(await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId))).toBe('PURGED');
  });
  it('receipt failure rolls field erasure back; retry probes and finalizes exactly once', async () => {
    const f = await claimFixture();
    const evidence = await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId);
    const crashing = worker.$extends({ query: { deletionReceipt: { async create() { throw new Error('synthetic finalization crash'); } } } }) as unknown as PrismaClient;
    await expect(finishDocumentPurge(crashing, f.claim.id, f.user.tenantId, evidence, async () => undefined)).rejects.toThrow('synthetic finalization crash');
    expect((await holder.extractionRun.findUniqueOrThrow({ where: { id: f.extraction.id } })).wrappedDek).not.toBeNull();
    expect((await holder.documentPurgeClaim.findUniqueOrThrow({ where: { id: f.claim.id } })).state).toBe('COMMITTED');
    expect(await holder.deletionReceipt.count({ where: { submissionId: f.doc.id } })).toBe(0);
    expect(await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId))).toBe('PURGED');
  });
  it('a completed document image claim repairs its orphan even after the pointer was cleared', async () => {
    const f = await claimFixture('IMAGE_ONLY');
    const orphan = await worker.storageOrphan.create({ data: { userId: f.user.id, tenantId: f.user.tenantId, key: f.fileKey, reason: 'ERASURE_PURGE_PROBE_FAILED' } });
    await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId));
    await placeDocLegalHold(holder, { ...holdInput(f), preserveRemainingData: true });
    expect(await retryStorageOrphan(worker, getStorageProvider(), { error: vi.fn() }, orphan.id)).toBe(true);
    expect((await holder.extractionRun.findUniqueOrThrow({ where: { id: f.extraction.id } })).wrappedDek).not.toBeNull();
  });
  it('backfill does not change a held or claimed null subject', async () => {
    const f = await claimFixture(); const held = await fixture();
    await placeDocLegalHold(holder, holdInput(held));
    expect(await backfillSubjects(documentMaintenanceScope(worker, [f.user.id, held.user.id]))).toMatchObject({ scanned: 0, resolved: 0 });
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).subjectId).toBeNull();
  });
});

describe('individual database guard responsibilities', () => {
  it('the claim insert guard independently refuses a held source', async () => {
    const f = await fixture(); await placeDocLegalHold(holder, holdInput(f));
    const fields = await worker.extractedField.findMany({ where: { submissionId: f.doc.id }, orderBy: { id: 'asc' } });
    await expect(worker.documentPurgeClaim.create({ data: {
      tenantId: f.user.tenantId, userId: f.user.id, documentId: f.doc.id, docType: f.doc.docType, role: f.doc.role,
      mode: 'FULL_ERASURE', sourceKind: 'OBJECT', sourceId: f.envelope.sourceId, fileKey: f.fileKey,
      storageNamespace: f.envelope.storageNamespace, sourceFingerprint: 'synthetic-unusable-fingerprint',
      sha256: f.envelope.sha256, sizeBytes: f.envelope.sizeBytes, runIds: [f.extraction.id], fieldIds: fields.map((r) => r.id), initiatedBy: 'synthetic-sql-bypass',
    } })).rejects.toThrow('document purge binding unavailable');
    expect(synthetic.deleted).not.toContain(f.fileKey);
  });
  it('claim provenance cannot change even when no CHECK or foreign key would reject it', async () => {
    const f = await claimFixture();
    await expect(worker.documentPurgeClaim.update({ where: { id: f.claim.id }, data: { initiatedBy: 'rewritten-synthetic-actor' } })).rejects.toThrow('immutable purge claim');
  });
  it('a committed claim does not allow a direct held stamp', async () => {
    const f = await claimFixture();
    const hold = await worker.docLegalHold.create({ data: { subjectUserId: f.user.id, tenantId: f.user.tenantId, reason: 'Synthetic raw hold metadata', ownerId: f.user.id, placedBy: f.user.id, reviewBy: new Date(Date.now() + 7 * DAY) } });
    await expect(holder.verificationDocument.update({ where: { id: f.doc.id }, data: { legalHoldId: hold.id } })).rejects.toThrow('DOCUMENT_PURGE_COMMITTED');
  });
  it('an unclaimed source cannot be marked image-purged or PURGED with raw SQL', async () => {
    const f = await fixture();
    await expect(worker.verificationDocument.update({ where: { id: f.doc.id }, data: { imagePurgedAt: new Date() } })).rejects.toThrow('committed document authority required');
    await expect(worker.$executeRaw`UPDATE verification_documents SET state = 'PURGED' WHERE id = ${f.doc.id}`).rejects.toThrow();
  });
  it('a hold freezes field-to-key identity as well as ciphertext', async () => {
    const f = await fixture();
    const second = await worker.extractionRun.create({ data: { submissionId: f.doc.id, tenantId: f.user.tenantId, profileCode: 'SYNTHETIC', engineName: 'synthetic', engineVersion: '2', startedAt: new Date(), outcome: 'OK', wrappedDek: new Uint8Array(40).fill(8) } });
    await placeDocLegalHold(holder, holdInput(f));
    await expect(worker.extractedField.updateMany({ where: { submissionId: f.doc.id }, data: { runId: second.id } })).rejects.toThrow('claimed extraction identity immutable');
  });
  it('an extraction field cannot disguise a different submission through its run', async () => {
    const f = await fixture(); const other = await fixture();
    await expect(worker.extractedField.create({ data: { submissionId: f.doc.id, runId: other.extraction.id, tenantId: f.user.tenantId, fieldCode: 'crossed', source: 'HUMAN', valueCt: new Uint8Array([7]) } })).rejects.toThrow('extracted field run lineage mismatch');
  });
  it('legal hold metadata remains permanent and cannot be rewritten', async () => {
    const f = await fixture(); const placed = await placeDocLegalHold(holder, holdInput(f));
    await expect(worker.docLegalHold.update({ where: { id: placed.hold.id }, data: { reason: 'rewrite' } })).rejects.toThrow('hold release is one way');
    await expect(worker.docLegalHold.delete({ where: { id: placed.hold.id } })).rejects.toThrow('hold provenance is permanent');
  });
  it('completed orphan authority does not permit reopening its obligation', async () => {
    const f = await orphanFixture();
    expect(await purgeUnattachedObject(worker, getStorageProvider(), f.orphan.id)).toBe(true);
    await expect(worker.storageOrphan.update({ where: { id: f.orphan.id }, data: { purgedAt: null } })).rejects.toThrow('claimed orphan identity immutable');
  });
  it('receipt SQL guard rejects successful image receipts while a source key remains', async () => {
    const f = await claimFixture('IMAGE_ONLY');
    await expect(worker.deletionReceipt.create({ data: {
      tenantId: f.user.tenantId, subjectId: f.user.id, submissionId: f.doc.id, docTypeCode: f.doc.docType,
      deletedBy: 'synthetic', purgeClaimId: f.claim.id, scope: 'IMAGE_ONLY', verificationProbeResult: 'CONFIRMED_ABSENT',
      contentSha256: null, bytesDeleted: 0n, storeLocations: [],
    } })).rejects.toThrow('receipt requires key absence');
  });
});

describe('stable ownership and policy barriers', () => {
  it('unretired envelope namespace and name reservation are immutable', async () => {
    const f = await fixture();
    await expect(worker.encryptedObject.update({ where: { fileKey: f.fileKey }, data: { storageNamespace: 'synthetic:rebound' } })).rejects.toThrow('storage namespace immutable');
    await expect(worker.encryptedObject.delete({ where: { fileKey: f.fileKey } })).rejects.toThrow('source names are permanent reservations');
    await expect(worker.encryptedObject.update({ where: { fileKey: f.fileKey }, data: { sha256: 'e'.repeat(64) } })).rejects.toThrow('source identity is immutable');
  });
  it('held ciphertext cannot be replaced with another non-null value', async () => {
    const f = await fixture(); await placeDocLegalHold(holder, holdInput(f));
    await expect(worker.extractedField.updateMany({ where: { submissionId: f.doc.id }, data: { valueCt: new Uint8Array([9]) } })).rejects.toThrow('held extraction immutable');
  });
  it('a claimed source cannot rebind to another existing subject', async () => {
    const f = await claimFixture();
    const subject = await worker.subject.create({ data: { tenantId: f.user.tenantId, countryCode: 'GY', kind: 'PERSON', createdById: f.user.id } });
    await expect(worker.verificationDocument.update({ where: { id: f.doc.id }, data: { subjectId: subject.id } })).rejects.toThrow('held or claimed identity immutable');
  });
  it('a claimed owner cannot move the source to a different existing tenant', async () => {
    const f = await claimFixture(); const id = `synthetic-${randomUUID()}`;
    await worker.tenant.create({ data: { id, slug: id, name: 'Synthetic mutation tenant', kind: 'REVIEW' } });
    await expect(worker.user.update({ where: { id: f.user.id }, data: { tenantId: id } })).rejects.toThrow('preservation authority owner immutable');
  });
  it('a completed release returns explicit conflict instead of overwriting provenance', async () => {
    const f = await fixture(); const held = await placeDocLegalHold(holder, holdInput(f));
    const input = { holdId: held.hold.id, releasedBy: f.user.id, reason: 'Synthetic release' };
    await releaseDocLegalHold(worker, input);
    await expect(releaseDocLegalHold(holder, input)).rejects.toMatchObject({ code: 'HOLD_ALREADY_RELEASED' });
  });
  it.each(['AML_RECORD', 'ACTIVE_LICENCE'] as const)('DSAR rechecks %s acquired after the preliminary policy read', async (ground) => {
    const f = await fixture(); const legacyCode = `synthetic_${randomUUID()}`; const code = `GY.${legacyCode}`;
    await worker.docType.create({ data: { code, countryCode: 'GY', legacyCode, displayName: 'Synthetic', bucket: 'PERSONAL', subjectKind: 'PERSON', issuer: 'Synthetic', imagePolicy: 'PURGE_AFTER_REVIEW', hasExpiry: false, extractionProfile: 'SYNTHETIC' } });
    await worker.verificationDocument.update({ where: { id: f.doc.id }, data: { docType: legacyCode } });
    const svc = service(worker); const original = svc.purgeDocumentNow.bind(svc);
    const spy = vi.spyOn(svc, 'purgeDocumentNow').mockImplementationOnce(async (...args) => {
      if (ground === 'AML_RECORD') await holder.docType.update({ where: { code }, data: { amlRecordClass: 'CDD_ENTITY' } });
      else await holder.rider.create({ data: { userId: f.user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
      return original(...args);
    });
    try {
      expect(await eraseDocumentsFor(worker, svc, f.user.id)).toEqual([expect.objectContaining({ outcome: 'REFUSED', ground })]);
      expect(synthetic.deleted).not.toContain(f.fileKey);
      expect(await holder.documentPurgeClaim.count({ where: { documentId: f.doc.id } })).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

it('claim, storage probe, field erasure and receipt complete under a real NOBYPASSRLS session', async () => {
  const f = await fixture();
  await worker.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'holdfence_probe_20260930') THEN CREATE ROLE holdfence_probe_20260930 NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await worker.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO holdfence_probe_20260930');
  await worker.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO holdfence_probe_20260930');
  await worker.$executeRawUnsafe('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO holdfence_probe_20260930');
  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('options', '-c role=holdfence_probe_20260930 -c app.current_tenant=swift-default');
  const role = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const [identity] = await role.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(identity).toEqual({ current_user: 'holdfence_probe_20260930', rolsuper: false, rolbypassrls: false });
    const claim = await runWithTenant(f.user.tenantId, () => claimDocumentPurge(role, getStorageProvider(), { documentId: f.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_ERASURE', initiatedBy: 'synthetic-role' }));
    expect(claim).not.toBeNull();
    const evidence = await runWithTenant(f.user.tenantId, () => probeCommittedPurge(role, getStorageProvider(), claim!.id, f.user.tenantId));
    expect(await runWithTenant(f.user.tenantId, () => finishDocumentPurge(role, claim!.id, f.user.tenantId, evidence, service(role).projectDocumentPurge.bind(service(role))))).toBe('PURGED');
    expect(await role.deletionReceipt.count({ where: { purgeClaimId: claim!.id } })).toBe(1);
    expect(synthetic.objects.has(f.fileKey)).toBe(false);
  } finally { await role.$disconnect(); }
});

// ---------------------------------------------------------------------------
// [DS617] Independent review of #1407: four findings, each proved red first.
// ---------------------------------------------------------------------------

async function extraSource(f: { user: { id: string } }, name: string, storageNamespace: string | null = 'synthetic:hold-fence') {
  const fileKey = `/uploads/verification/${f.user.id}/${name}.enc`;
  const bytes = Buffer.from(`Synthetic ${name} bytes, no personal data`);
  synthetic.objects.set(fileKey, bytes);
  const envelope = await worker.encryptedObject.create({ data: {
    fileKey, storageNamespace, createdBy: f.user.id, iv: new Uint8Array(12).fill(1), authTag: new Uint8Array(16).fill(2),
    wrappedDek: new Uint8Array(40).fill(3), sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: 'image/jpeg', sizeBytes: bytes.length,
  } });
  return { fileKey, envelope, bytes };
}
async function extraDocument(
  f: { user: { id: string } }, name: string,
  opts: { status?: 'PENDING' | 'APPROVED'; retentionExpiresAt?: Date | null; storageNamespace?: string | null } = {},
) {
  const source = await extraSource(f, name, opts.storageNamespace === undefined ? 'synthetic:hold-fence' : opts.storageNamespace);
  const doc = await worker.verificationDocument.create({ data: {
    userId: f.user.id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: source.fileKey,
    status: opts.status ?? 'PENDING', retentionExpiresAt: opts.retentionExpiresAt ?? null,
  } });
  return { ...source, doc };
}
/** A row as it existed before the fence: every other trigger (state machine, record, lineage) runs; only the
 *  fence's own insert guard, which did not exist yet, is skipped — inside this one transaction. */
async function preFenceDocument(f: { user: { id: string } }, data: { fileUrl: string; imagePurgedAt?: Date | null; imageSourceKind?: string }) {
  return worker.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE verification_documents DISABLE TRIGGER zz_document_hold_purge_guard');
    const doc = await tx.verificationDocument.create({ data: {
      userId: f.user.id, role: 'CUSTOMER', docType: 'identity_l2', status: 'APPROVED',
      retentionExpiresAt: new Date(Date.now() - DAY), ...data,
    } });
    await tx.$executeRawUnsafe('ALTER TABLE verification_documents ENABLE TRIGGER zz_document_hold_purge_guard');
    return doc;
  });
}
async function confirmFraud(docId: string) {
  const reviewer = async (n: string) => (await worker.user.create({ data: {
    id: `holdfence-reviewer-${n}-${randomUUID()}`, phone: `synthetic:reviewer-${randomUUID()}`, firstName: 'Synthetic', lastName: `Reviewer ${n}`,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE',
  } })).id;
  const [first, second] = [await reviewer('a'), await reviewer('b')];
  const svc = service(worker);
  // DOC-1 §24.2: the first fraud-class verdict escalates; a different reviewer confirms.
  expect((await svc.rejectDocument(docId, first, 'Synthetic suspicion', 'DUPLICATE')).status).toBe('PENDING');
  return { second, confirm: () => svc.rejectDocument(docId, second, 'Synthetic confirmation', 'DUPLICATE') };
}
async function committedFraud(docId: string) {
  const doc = await holder.verificationDocument.findUniqueOrThrow({ where: { id: docId } });
  expect(doc.status).toBe('REJECTED');
  const fraud = await holder.fraudCase.findFirstOrThrow({ where: { submissionId: docId } });
  expect(fraud.legalHoldId).not.toBeNull();
  expect(doc.legalHoldId).toBe(fraud.legalHoldId);
  expect((await holder.enforcementAction.findUniqueOrThrow({ where: { id: fraud.enforcementId! } })).level).toBe('BLOCK_PENDING_FOUNDER');
  return fraud;
}
const rawClaim = (f: { user: { id: string; tenantId: string } }, doc: { id: string; docType: string; role: string }, data: Partial<Prisma.DocumentPurgeClaimUncheckedCreateInput>) =>
  worker.documentPurgeClaim.create({ data: {
    tenantId: f.user.tenantId, userId: f.user.id, documentId: doc.id, docType: doc.docType, role: doc.role,
    mode: 'FULL_RETENTION', sourceKind: 'OBJECT', initiatedBy: 'synthetic-sql-bypass', ...data,
  } });

describe('[DS617 S1] a confirmed fraud always commits; its hold preserves what remains and records what cannot be preserved', () => {
  it('another document already under committed destruction: the conflict is recorded, the rest is held, purge-first still completes', async () => {
    const f = await claimFixture('FULL_RETENTION');
    const pending = await extraDocument(f, 'fraud-target');
    const { confirm } = await confirmFraud(pending.doc.id);
    await expect(confirm()).resolves.toMatchObject({ id: pending.doc.id, status: 'REJECTED' });
    await committedFraud(pending.doc.id);
    // Committed destruction is never revoked or falsely "held".
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).legalHoldId).toBeNull();
    expect(await holder.documentPurgeEvent.count({ where: { claimId: f.claim.id, kind: 'HOLD_CONFLICT_PURGE_COMMITTED' } })).toBe(1);
    expect(await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId))).toBe('PURGED');
  });

  it('a document whose image was already purged is held for its remaining record, and the hold says so', async () => {
    const f = await claimFixture('IMAGE_ONLY');
    expect(await finish(f, await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId))).toBe('PURGED');
    const pending = await extraDocument(f, 'fraud-target');
    const { confirm } = await confirmFraud(pending.doc.id);
    await expect(confirm()).resolves.toMatchObject({ status: 'REJECTED' });
    const fraud = await committedFraud(pending.doc.id);
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).legalHoldId).toBe(fraud.legalHoldId);
    const placed = await holder.documentPurgeEvent.findFirstOrThrow({ where: { holdId: fraud.legalHoldId!, kind: 'HOLD_PLACED' } });
    expect(placed.details).toMatchObject({ scope: 'REMAINING_DATA', missingImageDocumentIds: [f.doc.id] });
  });

  it('an unattached upload under committed destruction does not stop the documents being held', async () => {
    const f = await orphanFixture();
    synthetic.beforeRead = async (key) => { if (key === f.fileKey) throw new Error('synthetic provider outage'); };
    expect(await purgeUnattachedObject(worker, getStorageProvider(), f.orphan.id)).toBe(false);
    synthetic.beforeRead = undefined;
    const orphanClaim = await holder.documentPurgeClaim.findFirstOrThrow({ where: { orphanId: f.orphan.id } });
    expect(orphanClaim.state).toBe('COMMITTED');
    const pending = await extraDocument(f, 'fraud-target');
    const { confirm } = await confirmFraud(pending.doc.id);
    await expect(confirm()).resolves.toMatchObject({ status: 'REJECTED' });
    const fraud = await committedFraud(pending.doc.id);
    expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id: f.doc.id } })).legalHoldId).toBe(fraud.legalHoldId);
    expect(await holder.documentPurgeEvent.count({ where: { claimId: orphanClaim.id, kind: 'HOLD_CONFLICT_PURGE_COMMITTED' } })).toBe(1);
  });
});

describe('[DS617 S2] a whole-person hold also covers documents submitted after it', () => {
  it('retention, the reaper, DSAR erasure and raw SQL all refuse a later document; release ends the coverage', async () => {
    const f = await fixture();
    const placed = await placeDocLegalHold(holder, { ...holdInput(f), documentIds: undefined });
    expect(placed.documents).toBe(1);
    const later = await extraDocument(f, 'submitted-after-hold', { status: 'APPROVED', retentionExpiresAt: new Date(Date.now() - DAY) });
    expect(later.doc.legalHoldId).toBeNull();
    const claimLater = () => claimDocumentPurge(worker, getStorageProvider(), {
      documentId: later.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_RETENTION', initiatedBy: 'synthetic-test',
    });
    expect(await claimLater()).toBeNull();
    await service(documentMaintenanceScope(worker, [f.user.id])).purgeExpiredDocuments();
    expect(synthetic.deleted).not.toContain(later.fileKey);
    expect(await holder.documentPurgeClaim.count({ where: { documentId: later.doc.id } })).toBe(0);
    await expect(rawClaim(f, later.doc, {
      sourceId: later.envelope.sourceId, fileKey: later.fileKey, storageNamespace: later.envelope.storageNamespace,
      sourceFingerprint: 'synthetic-unusable-fingerprint', sha256: later.envelope.sha256, sizeBytes: later.envelope.sizeBytes,
    })).rejects.toThrow('subject-wide legal hold active');
    expect(await eraseDocumentsFor(worker, service(worker), f.user.id, [later.doc.id]))
      .toEqual([expect.objectContaining({ documentId: later.doc.id, outcome: 'REFUSED', ground: 'LEGAL_HOLD' })]);
    await releaseDocLegalHold(worker, { holdId: placed.hold.id, releasedBy: f.user.id, reason: 'Synthetic release' });
    expect(await claimLater()).not.toBeNull();
  });

  it('a subject access export reports a later document as under the whole-person hold', async () => {
    const id = `holdfence-${randomUUID()}`;
    const user = await worker.user.create({ data: { id, phone: `synthetic:${id}`, firstName: 'Synthetic', lastName: 'HoldFence', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE' } });
    const first = await extraDocument({ user }, 'held-at-placement', { status: 'APPROVED' });
    await placeDocLegalHold(holder, { subjectUserId: id, reason: 'Synthetic preservation', ownerId: id, placedBy: id, reviewBy: new Date(Date.now() + 7 * DAY) });
    const later = await extraDocument({ user }, 'after-hold-export', { status: 'APPROVED' });
    const exported = await exportDocumentsFor(worker, id);
    expect(exported.documents.map((d) => [d.id, d.underLegalHold])).toEqual([[first.doc.id, true], [later.doc.id, true]]);
  });

  it('a hold that names its documents covers only those, as specified (DOC-1 §9.4)', async () => {
    const f = await fixture();
    await placeDocLegalHold(holder, holdInput(f));
    const later = await extraDocument(f, 'beside-named-hold', { status: 'APPROVED', retentionExpiresAt: new Date(Date.now() - DAY) });
    expect(await claimDocumentPurge(worker, getStorageProvider(), {
      documentId: later.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_RETENTION', initiatedBy: 'synthetic-test',
    })).not.toBeNull();
  });

  it('account erasure defers every document of a person under a whole-person hold and says so', async () => {
    const f = await fixture();
    await placeDocLegalHold(holder, { ...holdInput(f), documentIds: undefined });
    const later = await extraDocument(f, 'submitted-before-erasure', { status: 'APPROVED' });
    const account = new AccountService({ prisma: worker, io: { in: () => ({ disconnectSockets: () => undefined }) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance);
    expect(await account.deleteAccount(f.user.id)).toMatchObject({ deleted: false });
    expect(synthetic.deleted).not.toContain(later.fileKey);
    expect(await holder.documentPurgeClaim.count({ where: { documentId: later.doc.id } })).toBe(0);
    const deferred = await holder.auditLog.findFirstOrThrow({ where: { action: 'ERASURE_DEFERRED_LEGAL_HOLD', entityId: f.user.id } });
    expect((deferred.changes as { heldDocuments?: number }).heldDocuments).toBe(2);
  });
});

describe('[DS617 S2] pre-fence documents stay purgeable without weakening the fence', () => {
  it('a pre-fence envelope with no recorded namespace is bound once, inside the claim, to the store the worker reaches', async () => {
    const f = await fixture();
    const legacy = await extraDocument(f, 'pre-fence-object', { status: 'APPROVED', retentionExpiresAt: new Date(Date.now() - DAY), storageNamespace: null });
    expect(await service(worker).purgeDocumentNow({ ...legacy.doc, user: f.user }, 'reaper', { requireRetentionElapsed: true, shredFields: false })).toBe('PURGED');
    expect(await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: legacy.fileKey } })).toMatchObject({ storageNamespace: 'synthetic:hold-fence', wrappedDek: null });
    const claim = await holder.documentPurgeClaim.findFirstOrThrow({ where: { documentId: legacy.doc.id } });
    expect(claim).toMatchObject({ sourceKind: 'OBJECT', storageNamespace: 'synthetic:hold-fence', state: 'COMPLETE' });
    expect(await holder.deletionReceipt.findUniqueOrThrow({ where: { purgeClaimId: claim.id } })).toMatchObject({ verificationProbeResult: 'CONFIRMED_ABSENT' });
    expect(await holder.documentPurgeEvent.count({ where: { userId: f.user.id, kind: 'SOURCE_NAMESPACE_ADOPTED' } })).toBe(1);
    // A recorded namespace is never rebound: a different one refuses before any external effect.
    const elsewhere = await extraDocument(f, 'recorded-elsewhere', { status: 'APPROVED', retentionExpiresAt: new Date(Date.now() - DAY), storageNamespace: 'synthetic:elsewhere' });
    await expect(claimDocumentPurge(worker, getStorageProvider(), {
      documentId: elsewhere.doc.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_RETENTION', initiatedBy: 'synthetic-test',
    })).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect((await holder.encryptedObject.findUniqueOrThrow({ where: { fileKey: elsewhere.fileKey } })).storageNamespace).toBe('synthetic:elsewhere');
    expect(synthetic.deleted).not.toContain(elsewhere.fileKey);
  });

  it('a pre-fence blank pointer retires its record without certifying any image destruction', async () => {
    const f = await fixture();
    const earlier = new Date(Date.now() - 30 * DAY);
    const doc = await preFenceDocument(f, { fileUrl: '', imagePurgedAt: earlier });
    expect(doc.imageSourceKind).toBe('UNPROVEN');
    expect(await service(worker).purgeDocumentNow({ ...doc, user: f.user }, 'reaper', { requireRetentionElapsed: true, shredFields: false })).toBe('PURGED');
    const after = await holder.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.purgedAt).not.toBeNull();
    expect(after.imageCompletionClaimId).toBeNull();
    expect(after.imagePurgedAt).toEqual(earlier);
    const claim = await holder.documentPurgeClaim.findFirstOrThrow({ where: { documentId: doc.id } });
    expect(claim).toMatchObject({ sourceKind: 'UNPROVEN_EMPTY', mode: 'FULL_RETENTION', state: 'COMPLETE' });
    expect(await holder.deletionReceipt.findUniqueOrThrow({ where: { purgeClaimId: claim.id } })).toMatchObject({ verificationProbeResult: 'NOT_APPLICABLE' });
  });

  it('only a pre-fence blank pointer qualifies: a fenced document, an image-only scope and raw SQL are refused', async () => {
    const f = await fixture();
    const fenced = await preFenceDocument(f, { fileUrl: '', imageSourceKind: 'OBJECT' });
    await expect(claimDocumentPurge(worker, getStorageProvider(), {
      documentId: fenced.id, userId: f.user.id, tenantId: f.user.tenantId, mode: 'FULL_RETENTION', initiatedBy: 'synthetic-test',
    })).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    await expect(rawClaim(f, fenced, { sourceKind: 'UNPROVEN_EMPTY' })).rejects.toThrow('legacy empty source mismatch');
    const legacy = await preFenceDocument(f, { fileUrl: '' });
    await expect(rawClaim(f, legacy, { sourceKind: 'UNPROVEN_EMPTY', mode: 'IMAGE_ONLY' })).rejects.toThrow('legacy empty source mismatch');
    expect(await holder.documentPurgeClaim.count({ where: { documentId: { in: [fenced.id, legacy.id] } } })).toBe(0);
  });

  it('the reaper completes its sweep and its heartbeat with pre-fence rows due', async () => {
    const f = await fixture();
    const legacyObject = await extraDocument(f, 'pre-fence-due', { status: 'APPROVED', retentionExpiresAt: new Date(Date.now() - DAY), storageNamespace: null });
    const legacyBlank = await preFenceDocument(f, { fileUrl: '' });
    const before = Date.now();
    await service(documentMaintenanceScope(worker, [f.user.id])).purgeExpiredDocuments();
    for (const id of [f.doc.id, legacyObject.doc.id, legacyBlank.id]) {
      expect((await holder.verificationDocument.findUniqueOrThrow({ where: { id } })).purgedAt).not.toBeNull();
    }
    // The blank pre-fence pointer gains no invented image-purge time and no image lineage.
    const blank = await holder.verificationDocument.findUniqueOrThrow({ where: { id: legacyBlank.id } });
    expect(blank.imagePurgedAt).toBeNull();
    expect(blank.imageCompletionClaimId).toBeNull();
    const heartbeat = await holder.platformConfig.findUniqueOrThrow({ where: { key: 'last_reaper_run_at' } });
    expect(new Date(String(heartbeat.value).replace(/^"|"$/g, '')).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

// ---------------------------------------------------------------------------
// [#1414 merge] Main takes the identity authority before any account row lock
// (subscription.service withActivation). A purge that projects can reach that
// activation, so it takes the authority first, too.
// ---------------------------------------------------------------------------

async function identityLockWaiterWhile(pending: () => boolean): Promise<'WAITING' | 'FINISHED' | 'TIMEOUT'> {
  for (let attempt = 0; attempt < 200 && pending(); attempt++) {
    const [row] = await worker.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
      WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`;
    if (row!.n > 0) return 'WAITING';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pending() ? 'TIMEOUT' : 'FINISHED';
}

describe('[#1414 merge] a purge that projects takes the identity authority before the person', () => {
  it('a full-retention finish waits for the identity authority without holding the person row', async () => {
    const f = await claimFixture('FULL_RETENTION');
    const evidence = await probeCommittedPurge(worker, getStorageProvider(), f.claim.id, f.user.tenantId);
    const held = barrier();
    const proceed = barrier();
    const authority = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('identity-authority-v1', 0))::text AS locked`;
      held.release();
      await proceed.promise;
      // The waiting finish has not taken the person's row: an identity writer can still lock it.
      return tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${f.user.id} FOR UPDATE NOWAIT`;
    }, { timeout: 30_000 });
    await held.promise;
    let settled = false;
    const finishing = finish(f, evidence).finally(() => { settled = true; });
    const first = await identityLockWaiterWhile(() => !settled);
    proceed.release();
    expect(await authority).toHaveLength(1);
    expect(first).toBe('WAITING');
    expect(await finishing).toBe('PURGED');
  });
});

// ---------------------------------------------------------------------------
// [DS625] Independent review of #1407 at 518507d5. Finding 2: a whole-person
// hold covers documents submitted after it (unstamped by design), so the
// database must refuse a direct delete of them, and of their extracted fields,
// the way the claim guard already refuses a claim — and must not let either
// be moved off the person, or to another submission, to escape it.
// ---------------------------------------------------------------------------

describe('[DS625 F2] a whole-person hold refuses direct database deletes of a later document', () => {
  it('a later document cannot be deleted or moved to another person until the hold is released', async () => {
    const f = await fixture();
    const placed = await placeDocLegalHold(holder, { ...holdInput(f), documentIds: undefined });
    const later = await extraDocument(f, 'raw-delete-after-hold', { status: 'APPROVED' });
    expect(later.doc.legalHoldId).toBeNull();
    const other = (await fixture()).user;
    await expect(worker.$executeRaw`DELETE FROM verification_documents WHERE id = ${later.doc.id}`).rejects.toThrow('subject-wide legal hold active');
    await expect(worker.$executeRaw`UPDATE verification_documents SET "userId" = ${other.id} WHERE id = ${later.doc.id}`).rejects.toThrow('subject-wide legal hold active');
    expect(await holder.verificationDocument.findUniqueOrThrow({ where: { id: later.doc.id } })).toMatchObject({ userId: f.user.id, legalHoldId: null });
    // Release ends the coverage: the same direct delete of the unstamped, unclaimed row is then the database's ordinary business.
    await releaseDocLegalHold(worker, { holdId: placed.hold.id, releasedBy: f.user.id, reason: 'Synthetic release' });
    expect(await worker.$executeRaw`DELETE FROM verification_documents WHERE id = ${later.doc.id}`).toBe(1);
  });

  it('extracted fields of a later document cannot be deleted or moved to another submission', async () => {
    const f = await fixture();
    await placeDocLegalHold(holder, { ...holdInput(f), documentIds: undefined });
    const later = await extraDocument(f, 'raw-extraction-after-hold', { status: 'APPROVED' });
    const run = await worker.extractionRun.create({ data: {
      submissionId: later.doc.id, tenantId: f.user.tenantId, profileCode: 'SYNTHETIC',
      engineName: 'synthetic', engineVersion: '1', startedAt: new Date(), outcome: 'OK',
      wrappedDek: new Uint8Array(40).fill(4),
      fields: { create: {
        submissionId: later.doc.id, tenantId: f.user.tenantId, fieldCode: 'synthetic_field',
        valueCt: new Uint8Array(40).fill(5), source: 'HUMAN',
      } },
    } });
    const elsewhere = (await fixture()).doc;
    await expect(worker.$executeRaw`DELETE FROM extracted_field WHERE "submissionId" = ${later.doc.id}`).rejects.toThrow('subject-wide legal hold active');
    await expect(worker.$executeRaw`DELETE FROM extraction_run WHERE id = ${run.id}::uuid`).rejects.toThrow('subject-wide legal hold active');
    await expect(worker.$executeRaw`UPDATE extraction_run SET "submissionId" = ${elsewhere.id} WHERE id = ${run.id}::uuid`).rejects.toThrow('extraction identity immutable');
    expect(await holder.extractionRun.count({ where: { id: run.id, submissionId: later.doc.id, wrappedDek: { not: null } } })).toBe(1);
    expect(await holder.extractedField.count({ where: { submissionId: later.doc.id, valueCt: { not: null } } })).toBe(1);
  });
});
