/** F-220-01: real PostgreSQL transaction/row-lock barriers for the account
 * cutoff and document reaper. Normal API CI only; the no-service config does
 * not include this file. Object bytes are synthetic in-memory storage; ORM
 * reads, writes, row locks, triggers and transaction rollback use the test DB.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { AccountService } from '../modules/user/account.service';
import { VerificationService } from '../modules/verification/verification.service';
import type { NotificationService } from '../modules/notification/notification.service';
import type { KycProvider } from '../providers/kyc/kyc-provider';

const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../providers/storage/storage-provider', () => ({
  getStorageProvider: () => ({
    getObject: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error('synthetic object absent'), { code: 'ENOENT' });
      return bytes;
    },
    delete: async (key: string) => { objects.delete(key); },
  }),
}));

let app: FastifyInstance;
const users: string[] = [];
const signal = () => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
};
const reachBeforeCompletion = (gate: ReturnType<typeof signal>, operation: Promise<unknown>) => Promise.race([
  gate.reached, operation.then(() => { throw new Error('operation completed before its required barrier'); }),
]);

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); objects.clear(); });
afterAll(async () => {
  if (!app?.prisma || users.length === 0) { await app?.close(); return; }
  await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});

async function fixture(metadataAvailable = true) {
  const user = await app.prisma.user.create({ data: {
    phone: `synthetic-erasure:${nanoid(20)}`, firstName: 'Synthetic', lastName: 'Erasure',
    activeRole: 'CUSTOMER', roles: ['CUSTOMER'],
  } });
  users.push(user.id);
  const fileKey = `/uploads/verification/${user.id}/${nanoid(24)}.enc`;
  const bytes = Buffer.from('synthetic image ciphertext'); objects.set(fileKey, bytes);
  const metadata = () => app.prisma.encryptedObject.create({ data: {
    fileKey, createdBy: user.id, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2),
    wrappedDek: Buffer.alloc(60, 3), mimeType: 'image/jpeg', sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } });
  if (metadataAvailable) await metadata();
  const doc = await app.prisma.verificationDocument.create({ data: {
    userId: user.id, role: 'CUSTOMER', docType: 'national_id', status: 'APPROVED',
    fileUrl: fileKey, retentionExpiresAt: new Date(Date.now() + 86_400_000),
  }, include: { user: { select: { tenantId: true } } } });
  await app.prisma.extractionRun.create({ data: {
    submissionId: doc.id, profileCode: 'UNPROFILED', engineName: 'synthetic', engineVersion: '1',
    startedAt: new Date(), outcome: 'OK', wrappedDek: Buffer.alloc(60, 4),
    fields: { create: { submissionId: doc.id, fieldCode: 'doc_number', valueCt: Buffer.from('synthetic field ciphertext'), source: 'PROVIDER' } },
  } });
  const cleanupReached = signal(); const resumeCleanup = signal();
  let pauseCleanup = false;
  // Scope only the background work census to this fixture. All supplied
  // predicates and the full ownership/reference census still execute in PG.
  const db = app.prisma.$extends({ query: {
    verificationDocument: { async findMany({ args, query }) {
      if (args.where?.retentionExpiresAt) args.where = { ...args.where, userId: user.id };
      return query(args);
    } },
    storageOrphan: { async findMany({ args, query }) {
      if (pauseCleanup) { pauseCleanup = false; cleanupReached.release(); await resumeCleanup.reached; }
      return query({ ...args, where: { ...args.where, userId: user.id } });
    } },
  } }) as unknown as PrismaClient;
  const account = (client = db) => new AccountService({ prisma: client, log: app.log } as FastifyInstance);
  const verification = (client = db) => new VerificationService(client, {} as NotificationService, {} as KycProvider);
  const state = () => app.prisma.verificationDocument.findUniqueOrThrow({
    where: { id: doc.id }, include: { extractionRuns: { include: { fields: true } } },
  });
  const assertErased = async () => {
    const row = await state();
    expect(row.purgedAt).not.toBeNull(); expect(row.fileUrl).toBe('');
    expect(row.extractionRuns).toHaveLength(1);
    expect(row.extractionRuns[0]!.wrappedDek).toBeNull();
    expect(row.extractionRuns[0]!.fields).toHaveLength(1);
    expect(row.extractionRuns[0]!.fields[0]!.valueCt).toBeNull();
    const receipts = await app.prisma.deletionReceipt.findMany({ where: { submissionId: doc.id } });
    expect(receipts).toHaveLength(1); expect(receipts[0]!.verificationProbeResult).toBe('CONFIRMED_ABSENT');
  };
  const advancePastCutoff = async () => {
    const row = await state(); expect(row.retentionExpiresAt).not.toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(row.retentionExpiresAt!.getTime() + 1));
  };
  return { user, doc, db, account, verification, metadata, state, assertErased, advancePastCutoff,
    cleanupReached, resumeCleanup, pauseIndependentCleanup: () => { pauseCleanup = true; } };
}

// Instrument only scheduling around real interactive transactions. Every
// callback and lock still reaches the same Prisma transaction/connection.
function transactions(db: PrismaClient, hooks: {
  afterCommit?: () => Promise<void>;
  afterUserUpdate?: () => Promise<void>;
  purgeLockAttempted?: () => void;
  failFieldShred?: boolean;
}): PrismaClient {
  return new Proxy(db, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return async (body: (tx: Prisma.TransactionClient) => Promise<unknown>, ...options: unknown[]) => {
      const result = await Reflect.apply(target.$transaction, target, [async (tx: Prisma.TransactionClient) => body(new Proxy(tx, {
        get(transaction, member) {
          if (member === 'user' && hooks.afterUserUpdate) return new Proxy(transaction.user, { get(delegate, operation) {
            if (operation !== 'update') return Reflect.get(delegate, operation);
            return async (args: Prisma.UserUpdateArgs) => { const value = await delegate.update(args); await hooks.afterUserUpdate!(); return value; };
          } });
          if (member === '$queryRaw' && hooks.purgeLockAttempted) return (...args: unknown[]) => {
            const pending = Reflect.apply(transaction.$queryRaw, transaction, args);
            if (String(args[0]).includes('verification-document-purge-authority')) hooks.purgeLockAttempted!();
            return pending;
          };
          if (member === 'extractedField' && hooks.failFieldShred) return new Proxy(transaction.extractedField, { get(delegate, operation) {
            if (operation === 'updateMany') return async () => { throw new Error('synthetic field-shred failure'); };
            return Reflect.get(delegate, operation);
          } });
          return Reflect.get(transaction, member);
        },
      })), ...options]);
      await hooks.afterCommit?.(); return result;
    };
  } }) as PrismaClient;
}

describe('F-220-01 account erasure/reaper PostgreSQL barriers', () => {
  it('committed cutoff makes a future document due; a winning reaper erases its values before account cleanup resumes', async () => {
    const h = await fixture(); const cutoff = signal(); const resume = signal(); let first = true;
    const accountDb = transactions(h.db, { afterCommit: async () => {
      if (first) { first = false; cutoff.release(); await resume.reached; }
    } });
    const deleting = h.account(accountDb).deleteAccount(h.user.id);
    try {
      await reachBeforeCompletion(cutoff, deleting);
      expect(await app.prisma.user.findUniqueOrThrow({ where: { id: h.user.id } })).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${h.user.id}`, firstName: 'Synthetic' });
      await h.advancePastCutoff();
      await expect(h.verification().purgeExpiredDocuments()).resolves.toBe(1);
      await h.assertErased();
    } finally { resume.release(); await deleting; }
    await expect(deleting).resolves.toEqual({ deleted: true });
    await expect(h.verification().purgeExpiredDocuments()).resolves.toBe(0);
  });

  it('metadata recovery during independent cleanup consumes the durable pending obligation with its extracted values', async () => {
    const h = await fixture(false); h.pauseIndependentCleanup();
    const deleting = h.account().deleteAccount(h.user.id);
    try {
      await reachBeforeCompletion(h.cleanupReached, deleting);
      expect((await h.state()).purgedAt).toBeNull();
      expect(await app.prisma.deletionReceipt.count({ where: { submissionId: h.doc.id } })).toBe(0);
      expect((await app.prisma.user.findUniqueOrThrow({ where: { id: h.user.id } })).firstName).toBe('Synthetic');
      await h.metadata(); await h.advancePastCutoff();
      await expect(h.verification().purgeExpiredDocuments()).resolves.toBe(1);
      await h.assertErased();
    } finally { h.resumeCleanup.release(); await deleting; }
    await expect(deleting).resolves.toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingDocuments: 1 });
    await expect(h.verification().purgeExpiredDocuments()).resolves.toBe(0);
  });

  it('a stale candidate waiting behind the real cutoff transaction consumes the marker after the user lock', async () => {
    const h = await fixture(); const staged = signal(); const commit = signal(); const attempted = signal(); const finishAccount = signal();
    let first = true;
    const accountDb = transactions(h.db, {
      afterUserUpdate: async () => { if (first) { first = false; staged.release(); await commit.reached; } },
      afterCommit: async () => { await finishAccount.reached; },
    });
    const deleting = h.account(accountDb).deleteAccount(h.user.id);
    let purging: Promise<string> | undefined;
    try {
      await reachBeforeCompletion(staged, deleting);
      // Another connection sees the pre-cutoff row until the transaction commits.
      expect(await app.prisma.user.findUniqueOrThrow({ where: { id: h.user.id } })).toMatchObject({ status: 'ACTIVE', phone: h.user.phone });
      const reaperDb = transactions(h.db, { purgeLockAttempted: attempted.release });
      purging = h.verification(reaperDb).purgeDocumentNow(h.doc, 'reaper', { requireRetentionElapsed: true, shredFields: false, now: new Date(Date.now() + 1) });
      await reachBeforeCompletion(attempted, purging);
      expect((await h.state()).purgedAt).toBeNull();
      commit.release();
      await expect(purging).resolves.toBe('PURGED'); await h.assertErased();
    } finally { commit.release(); finishAccount.release(); await Promise.allSettled([deleting, purging]); }
    await expect(deleting).resolves.toEqual({ deleted: true });
  });

  it('a field-shred failure rolls back document retirement and its passing receipt', async () => {
    const h = await fixture();
    await app.prisma.$transaction(async (tx) => {
      await tx.verificationDocument.update({ where: { id: h.doc.id }, data: { retentionExpiresAt: new Date(Date.now() - 1) } });
      await tx.user.update({ where: { id: h.user.id }, data: { status: 'DEACTIVATED', phone: `deleted:${h.user.id}` } });
    });
    const failing = h.verification(transactions(h.db, { failFieldShred: true }));
    await expect(failing.purgeDocumentNow(h.doc, 'reaper', { requireRetentionElapsed: true, shredFields: false })).rejects.toThrow('synthetic field-shred failure');
    const row = await h.state();
    expect(row.purgedAt).toBeNull(); expect(row.fileUrl).toBe(h.doc.fileUrl);
    expect(row.retentionExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(row.extractionRuns[0]!.wrappedDek).not.toBeNull();
    expect(row.extractionRuns[0]!.fields[0]!.valueCt).not.toBeNull();
    expect(await app.prisma.deletionReceipt.count({ where: { submissionId: h.doc.id } })).toBe(0);
    // The already-shredded image remains an explicit unresolved obligation;
    // this test does not claim the separate partial-shred recovery is solved.
  });
});
