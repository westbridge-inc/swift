/** F-220-01 / F-224-01: real PostgreSQL transaction/row-lock barriers for the
 * account cutoff, retention scheduler and reaper. Normal API CI only; the no-service config does
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
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant } from '../plugins/tenant-context';
import { retentionDaysFor } from '../modules/verification/retention-policy';
import { registryCode } from '../modules/verification/doc-registry';
import { eraseDocumentsFor } from '../modules/verification/dsar';
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
const policyCodes: string[] = [];
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
  await app.prisma.docType.deleteMany({ where: { code: { in: policyCodes } } });
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
  backend?: (pid: number) => void;
  afterCommit?: () => Promise<void>;
  afterUserUpdate?: () => Promise<void>;
  afterRetentionLock?: () => Promise<void>;
  afterRetentionWrite?: (result: { count: number }) => Promise<void>;
  purgeLockAttempted?: () => void;
  failFieldShred?: boolean;
}): PrismaClient {
  return new Proxy(db, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return async (body: (tx: Prisma.TransactionClient) => Promise<unknown>, ...options: unknown[]) => {
      const result = await Reflect.apply(target.$transaction, target, [async (tx: Prisma.TransactionClient) => {
        if (hooks.backend) {
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          hooks.backend(backend!.pid);
        }
        return body(new Proxy(tx, {
          get(transaction, member) {
            if (member === 'user' && hooks.afterUserUpdate) return new Proxy(transaction.user, { get(delegate, operation) {
              if (operation !== 'update') return Reflect.get(delegate, operation);
              return async (args: Prisma.UserUpdateArgs) => { const value = await delegate.update(args); await hooks.afterUserUpdate!(); return value; };
            } });
            if (member === '$queryRaw' && (hooks.purgeLockAttempted || hooks.afterRetentionLock)) return async (...args: unknown[]) => {
              const pending = Reflect.apply(transaction.$queryRaw, transaction, args);
              if (String(args[0]).includes('verification-document-purge-authority')) hooks.purgeLockAttempted?.();
              const value = await pending;
              if (String(args[0]).includes('verification-retention-schedule-authority')) await hooks.afterRetentionLock?.();
              return value;
            };
            if (member === 'verificationDocument' && hooks.afterRetentionWrite) return new Proxy(transaction.verificationDocument, { get(delegate, operation) {
              if (operation !== 'updateMany') return Reflect.get(delegate, operation);
              return async (args: Prisma.VerificationDocumentUpdateManyArgs) => {
                const result = await delegate.updateMany(args); await hooks.afterRetentionWrite!(result); return result;
              };
            } });
            if (member === 'extractedField' && hooks.failFieldShred) return new Proxy(transaction.extractedField, { get(delegate, operation) {
              if (operation === 'updateMany') return async () => { throw new Error('synthetic field-shred failure'); };
              return Reflect.get(delegate, operation);
            } });
            return Reflect.get(transaction, member);
          },
        }));
      }, ...options]);
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

// Observe the server's actual lock wait, not merely invocation of a lazy
// PrismaPromise. Scope the query to the two known test-transaction backends.
async function blockedBy(waiter: () => number | undefined, blocker: number) {
  await expect.poll(async () => {
    const pid = waiter(); if (pid === undefined) return false;
    // Prisma binds JavaScript integers as int8; pg_blocking_pids accepts a
    // PostgreSQL backend PID (int4). Keep this witness typed like the server
    // value instead of repeatedly calling a non-existent bigint overload.
    const [row] = await app.prisma.$queryRaw<Array<{ blockers: number[] }>>`SELECT pg_blocking_pids(${pid}::integer) AS blockers`;
    return row!.blockers.includes(blocker);
  }, { interval: 10, timeout: 2000 }).toBe(true);
}

async function invokeBan(h: Awaited<ReturnType<typeof fixture>>) {
  const admin = await app.prisma.user.create({ data: {
    phone: `synthetic-retention-admin:${nanoid(20)}`, firstName: 'Synthetic', lastName: 'Admin',
    roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', tenantId: h.user.tenantId,
  } }); users.push(admin.id);
  type Handler = (request: unknown) => Promise<unknown>;
  const routes = new Map<string, Handler>();
  const host: Record<string, unknown> = { prisma: h.db, log: app.log, io: {}, prefix: '', addHook: () => {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    host[method] = (path: string, ...args: unknown[]) => { routes.set(`${method} ${path}`, args.at(-1) as Handler); };
  }
  await adminRoutes(host as unknown as FastifyInstance);
  // Actual registered handler/status authority/scheduler; authentication and
  // transport are supplied boundaries, not an HTTP middleware certification.
  return runWithTenant(h.user.tenantId, () => routes.get('put /users/:id/ban')!({
    params: { id: h.user.id }, body: { reason: 'Synthetic retention regression' },
    user: { userId: admin.id, role: 'SUPER_ADMIN' }, headers: {}, ip: '127.0.0.1',
  }));
}

describe('F-224-01 monotonic retention at PostgreSQL authority boundaries', () => {
  it('actual admin ban keeps missing-metadata erasure pending and restored metadata immediately recoverable', async () => {
    const h = await fixture(false);
    await expect(h.account().deleteAccount(h.user.id)).resolves.toMatchObject({ status: 'PENDING_DOCUMENT_ERASURE' });
    const cutoff = (await h.state()).retentionExpiresAt;
    await invokeBan(h);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: h.user.id } })).toMatchObject({ status: 'BANNED', phone: `deleted:${h.user.id}` });
    expect((await h.state()).retentionExpiresAt).toEqual(cutoff);
    await h.advancePastCutoff();
    await expect(h.verification().purgeExpiredDocuments()).rejects.toMatchObject({ code: 'VERIFICATION_OBJECT_UNAVAILABLE' });
    expect(await app.prisma.deletionReceipt.count({ where: { submissionId: h.doc.id } })).toBe(0);
    await h.metadata();
    await expect(h.verification().purgeExpiredDocuments()).resolves.toBe(1); await h.assertErased();
  });

  it.each(['cutoff-first', 'scheduler-first'])('observes the real user-lock wait with %s and never postpones cutoff', async (order) => {
    const h = await fixture(false);
    await app.prisma.verificationDocument.update({ where: { id: h.doc.id }, data: { retentionExpiresAt: null } });
    const held = signal(); const release = signal(); const finishAccount = signal();
    let accountPid: number | undefined; let schedulerPid: number | undefined; let first = true;
    const accountDb = transactions(h.db, {
      backend: (pid) => { accountPid = pid; },
      afterUserUpdate: async () => {
        if (first && order === 'cutoff-first') { first = false; held.release(); await release.reached; }
      },
      afterCommit: async () => { await finishAccount.reached; },
    });
    const schedulerDb = transactions(h.db, {
      backend: (pid) => { schedulerPid = pid; },
      afterRetentionLock: async () => {
        if (order === 'scheduler-first') { held.release(); await release.reached; }
      },
    });
    let deleting: Promise<unknown> | undefined; let scheduling: Promise<number> | undefined;
    try {
      if (order === 'cutoff-first') {
        deleting = h.account(accountDb).deleteAccount(h.user.id);
        await reachBeforeCompletion(held, deleting);
        scheduling = h.verification(schedulerDb).scheduleDocumentRetention(h.user.id);
        await blockedBy(() => schedulerPid, accountPid!);
      } else {
        scheduling = h.verification(schedulerDb).scheduleDocumentRetention(h.user.id);
        await reachBeforeCompletion(held, scheduling);
        deleting = h.account(accountDb).deleteAccount(h.user.id);
        await blockedBy(() => accountPid, schedulerPid!);
      }
      expect((await h.state()).retentionExpiresAt).toBeNull(); // no uncommitted clock leaked
      release.release();
      await expect(scheduling).resolves.toBe(order === 'cutoff-first' ? 0 : 1);
      finishAccount.release();
      await expect(deleting).resolves.toMatchObject({ status: 'PENDING_DOCUMENT_ERASURE' });
      const cutoff = (await h.state()).retentionExpiresAt!;
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
      await h.metadata(); await h.advancePastCutoff();
      await expect(h.verification().purgeExpiredDocuments()).resolves.toBe(1); await h.assertErased();
    } finally { release.release(); finishAccount.release(); await Promise.allSettled([deleting, scheduling]); }
  });

  it('a rolled-back cutoff releases its waiting scheduler without retaining a false erasure marker or due clock', async () => {
    const h = await fixture(false); const held = signal(); const release = signal();
    await app.prisma.verificationDocument.update({ where: { id: h.doc.id }, data: { retentionExpiresAt: null } });
    let accountPid: number | undefined; let schedulerPid: number | undefined;
    const deleting = h.account(transactions(h.db, {
      backend: (pid) => { accountPid = pid; },
      afterUserUpdate: async () => { held.release(); await release.reached; throw new Error('synthetic cutoff rollback'); },
    })).deleteAccount(h.user.id);
    // Observe rejection immediately, including when a failed barrier releases it.
    const rejected = expect(deleting).rejects.toThrow('synthetic cutoff rollback');
    let scheduling: Promise<number> | undefined;
    try {
      await reachBeforeCompletion(held, deleting);
      scheduling = h.verification(transactions(h.db, { backend: (pid) => { schedulerPid = pid; } })).scheduleDocumentRetention(h.user.id);
      await blockedBy(() => schedulerPid, accountPid!);
      release.release(); await rejected; await expect(scheduling).resolves.toBe(1);
      expect(await app.prisma.user.findUniqueOrThrow({ where: { id: h.user.id } })).toMatchObject({ status: 'ACTIVE', phone: h.user.phone });
      const row = await h.state(); expect(row.retentionExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(row.purgedAt).toBeNull(); expect(row.extractionRuns[0]!.wrappedDek).not.toBeNull();
      expect(row.extractionRuns[0]!.fields[0]!.valueCt).not.toBeNull();
      expect(await app.prisma.deletionReceipt.count({ where: { submissionId: h.doc.id } })).toBe(0);
    } finally { release.release(); await Promise.allSettled([rejected, scheduling]); }
  });

  it('a scheduler write failure rolls back its whole batch, leaving all existing deadlines and erasure material intact', async () => {
    const h = await fixture();
    await app.prisma.verificationDocument.update({ where: { id: h.doc.id }, data: { retentionExpiresAt: null } });
    const second = await app.prisma.verificationDocument.create({ data: {
      userId: h.user.id, role: 'CUSTOMER', docType: 'national_id', fileUrl: '', status: 'REJECTED',
    } });
    let stagedWrites = 0;
    const failing = h.verification(transactions(h.db, { afterRetentionWrite: async (result) => {
      stagedWrites += result.count; throw new Error('synthetic retention rollback');
    } }));
    await expect(failing.scheduleDocumentRetention(h.user.id)).rejects.toThrow('synthetic retention rollback');
    expect(stagedWrites).toBe(1);
    expect((await h.state()).retentionExpiresAt).toBeNull();
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: second.id } })).retentionExpiresAt).toBeNull();
    const row = await h.state(); expect(row.purgedAt).toBeNull();
    expect(row.extractionRuns[0]!.wrappedDek).not.toBeNull(); expect(row.extractionRuns[0]!.fields[0]!.valueCt).not.toBeNull();
    expect(objects.has(h.doc.fileUrl)).toBe(true);
    expect(await app.prisma.deletionReceipt.count({ where: { submissionId: h.doc.id } })).toBe(0);
  });

  it.each(['null', 'due', 'earlier', 'equal', 'later'])('the atomic UPDATE preserves the earliest %s clock and repeated scheduling changes nothing', async (kind) => {
    const h = await fixture(); const config = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: h.user.countryCode } });
    const ruling = await retentionDaysFor(h.db, { countryCode: h.user.countryCode, docType: h.doc.docType, role: h.doc.role, countryDefaultDays: config.dataRetentionDays });
    expect(ruling.amlRecord).toBe(false);
    const now = Date.now(); const proposed = now + ruling.days * 86_400_000;
    const existing = kind === 'null' ? null : new Date(kind === 'due' ? now - 1 : proposed + (kind === 'earlier' ? -1000 : kind === 'later' ? 1000 : 0));
    await app.prisma.verificationDocument.update({ where: { id: h.doc.id }, data: { retentionExpiresAt: existing } });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    await expect(h.verification().scheduleDocumentRetention(h.user.id)).resolves.toBe(kind === 'null' || kind === 'later' ? 1 : 0);
    const earliest = existing === null ? proposed : Math.min(existing.getTime(), proposed);
    expect((await h.state()).retentionExpiresAt!.getTime()).toBe(earliest);
    vi.setSystemTime(new Date(now + 86_400_000));
    await expect(h.verification().scheduleDocumentRetention(h.user.id)).resolves.toBe(0);
    expect((await h.state()).retentionExpiresAt!.getTime()).toBe(earliest);
  });

  it.each([365, 3000])('a newly applicable AML class preserves the pre-existing %s-day policy extension and DSAR refusal', async (registryDays) => {
    const h = await fixture(); const legacyCode = `f224_aml_${nanoid(12)}`;
    const code = registryCode(h.user.countryCode, legacyCode);
    await app.prisma.docType.create({ data: {
      code, legacyCode, countryCode: h.user.countryCode, displayName: 'Synthetic AML fixture',
      bucket: 'BUSINESS', subjectKind: 'BUSINESS', issuer: 'Synthetic', imagePolicy: 'PERSIST',
      persistRetentionDays: registryDays, amlRecordClass: 'NOT_APPLICABLE', hasExpiry: false, extractionProfile: 'UNPROFILED',
    } }); policyCodes.push(code);
    const now = Date.now();
    await app.prisma.verificationDocument.update({ where: { id: h.doc.id }, data: { docType: legacyCode, retentionExpiresAt: new Date(now - 1) } });
    // Only this isolated synthetic policy row changes; no seeded market row.
    await app.prisma.docType.update({ where: { code }, data: { amlRecordClass: 'CDD_ENTITY' } });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    await expect(h.verification().scheduleDocumentRetention(h.user.id)).resolves.toBe(1);
    expect((await h.state()).retentionExpiresAt!.getTime()).toBe(now + Math.max(registryDays, 2555) * 86_400_000);
    // This correction does not change the old AML restart semantics either.
    vi.setSystemTime(new Date(now + 86_400_000));
    await expect(h.verification().scheduleDocumentRetention(h.user.id)).resolves.toBe(1);
    expect((await h.state()).retentionExpiresAt!.getTime()).toBe(now + (Math.max(registryDays, 2555) + 1) * 86_400_000);
    await expect(eraseDocumentsFor(h.db, h.verification(), h.user.id)).resolves.toEqual([
      expect.objectContaining({ documentId: h.doc.id, outcome: 'REFUSED', ground: 'AML_RECORD' }),
    ]);
    const row = await h.state(); expect(row.purgedAt).toBeNull(); expect(row.extractionRuns[0]!.wrappedDek).not.toBeNull();
    expect(row.extractionRuns[0]!.fields[0]!.valueCt).not.toBeNull(); expect(objects.has(h.doc.fileUrl)).toBe(true);
    expect(await app.prisma.deletionReceipt.count({ where: { submissionId: h.doc.id } })).toBe(0);
  });
});
