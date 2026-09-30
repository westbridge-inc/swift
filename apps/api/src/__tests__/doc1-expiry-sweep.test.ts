import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient, DocState } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { reconcileProviderVerifications } from '../modules/services/services.service';
import { approvedEvidenceFor } from '../modules/verification/evidence';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';

// Exercise the processor installed by createWorkers without starting consumers.
vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    constructor(readonly name: string, readonly processor: (job: unknown) => Promise<void>) { super(); }
    async close() {}
  }
  return { Worker, Queue: class {} };
});

const run = nanoid(12);
const users: string[] = [];
const docs: string[] = [];
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'plat1-expiry-regression');
let app: FastifyInstance;
let service: VerificationService;
let seq = 0;

async function user() {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+592085${Date.now()}${++seq}`, firstName: 'Synthetic', lastName: 'Fixture',
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', countryCode: 'GY', syntheticRunId: run,
  } }));
  users.push(u.id);
  await signupSelfieFixture(app.prisma, u.id);
  return u.id;
}

async function committed(userId: string, days: number) {
  const d = await runWithTenant('swift-default', async () => service.submitDocument(
    userId, 'RESTAURANT', 'business_registration', await ownedVerificationFixture(app.prisma, userId), 'v1',
  ));
  docs.push(d.id);
  await system(() => service.approveDocument(d.id, 'synthetic-reviewer', new Date(Date.now() + days * DAY)));
  return d.id;
}

async function lapse(id: string) {
  await system(() => app.prisma.verificationDocument.update({ where: { id }, data: { expiresAt: new Date(Date.now() - DAY) } }));
}

async function pending(userId: string, state: DocState) {
  const d = await system(() => app.prisma.verificationDocument.create({ data: {
    userId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: `synthetic/${run}`,
    state, expiresAt: new Date(Date.now() - DAY),
  } }));
  docs.push(d.id);
  return d.id;
}

function poisonedProvider(...providerIds: string[]): PrismaClient {
  return app.prisma.$extends({ query: { serviceProvider: { async update({ args, query }) {
    if (providerIds.includes(args.where.id ?? '')) throw new Error('synthetic provider projection failure');
    return query(args);
  } } } }) as unknown as PrismaClient;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin); await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (docs.length) await system(() => app.prisma.verificationDocument.deleteMany({ where: { id: { in: docs.splice(0) } } }));
  if (users.length) await system(async () => {
    const ids = users.splice(0);
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
});
afterAll(async () => { await app?.close(); });

describe('PLAT-1 expiry and reconciliation through service and job seams', () => {
  it('leaves an expired superseded approval untouched and expires a later row; current evidence and renewal notices survive', async () => {
    const owner = await user();
    const old = await committed(owner, 20);
    const current = await committed(owner, 400);
    await lapse(old);
    const later = await committed(await user(), 20);
    await lapse(later);
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: old } })))
      .toMatchObject({ state: 'SUPERSEDED', status: 'APPROVED' });
    expect(await system(() => service.expireLapsedDocuments())).toBe(1);
    expect(await system(() => app.prisma.documentRecord.findUnique({ where: { submissionId: old } }))).toMatchObject({ status: 'SUPERSEDED' });
    expect(await system(() => app.prisma.documentRecord.findUnique({ where: { submissionId: current } }))).toMatchObject({ status: 'VALID' });
    expect(await system(() => approvedEvidenceFor(app.prisma, owner, ['business_registration'], new Date()))).toHaveLength(1);
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: later } }))).toMatchObject({ state: 'EXPIRED', status: 'EXPIRED' });
    expect(await system(() => app.prisma.renewalSchedule.findUnique({ where: { documentId: later } }))).toMatchObject({ suspendedAt: expect.any(Date) });
    await system(() => app.prisma.verificationDocument.update({ where: { id: current }, data: { expiresAt: new Date(Date.now() + 20 * DAY) } }));
    expect(await system(() => service.sendExpiryReminders())).toBe(1);
    expect(await system(() => service.sendExpiryReminders())).toBe(0);
  });

  it.each(['CAPTURED', 'PREPROCESSED', 'EXTRACTING', 'EXTRACTED', 'VALIDATED', 'AUTO_APPROVED', 'APPROVED'] as const)('reports overdue %s as held, continues the later legal expiry, and reports the retained row again on retry', async (state) => {
    const held = await pending(await user(), state);
    const legal = await pending(await user(), 'REVIEW_QUEUED');
    await expect(system(() => service.expireLapsedDocuments())).rejects.toMatchObject({
      code: 'VERIFICATION_SWEEP_INCOMPLETE', completed: 1,
      counts: { expiry_policy_hold: 1 }, samples: expect.arrayContaining([expect.objectContaining({ id: held, state })]),
    });
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: legal } }))).toMatchObject({ state: 'EXPIRED' });
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: held } }))).toMatchObject({ state });
    await expect(system(() => service.expireLapsedDocuments())).rejects.toMatchObject({ completed: 0, counts: { expiry_policy_hold: 1 } });
  });

  it('isolates a poison provider, counts only successful projections, and heals the failed row on retry', async () => {
    const first = await user(), second = await user();
    const poison = await system(() => app.prisma.serviceProvider.create({ data: { id: `plat1-a-${run}`, userId: first, trade: 'plumber', isVerified: true } }));
    await system(() => app.prisma.serviceProvider.create({ data: { id: `plat1-z-${run}`, userId: second, trade: 'plumber', isVerified: true } }));
    await expect(system(() => reconcileProviderVerifications(poisonedProvider(poison.id), 1))).rejects.toMatchObject({
      code: 'VERIFICATION_SWEEP_INCOMPLETE', completed: 1, counts: { provider_reconcile: 1 },
    });
    expect(await system(() => app.prisma.serviceProvider.findUnique({ where: { userId: second } }))).toMatchObject({ isVerified: false });
    expect(await system(() => app.prisma.serviceProvider.findUnique({ where: { userId: first } }))).toMatchObject({ isVerified: true });
    expect(await system(() => reconcileProviderVerifications(app.prisma, 1))).toBe(2);
    expect(await system(() => app.prisma.serviceProvider.findUnique({ where: { userId: first } }))).toMatchObject({ isVerified: false });
  });

  it('re-reads under the authority lock when renewal commits after expiry candidate selection', async () => {
    const owner = await user();
    const old = await committed(owner, 20); await lapse(old);
    const renewal = await runWithTenant('swift-default', async () => service.submitDocument(
      owner, 'RESTAURANT', 'business_registration', await ownedVerificationFixture(app.prisma, owner), 'v1',
    ));
    docs.push(renewal.id);
    let raced = false;
    const racingClient = app.prisma.$extends({ query: { verificationDocument: { async findMany({ args, query }) {
      const rows = await query(args);
      if (!raced && args.where?.expiresAt) {
        raced = true;
        await service.approveDocument(renewal.id, 'synthetic-reviewer', new Date(Date.now() + 400 * DAY));
      }
      return rows;
    } } } }) as unknown as PrismaClient;
    const racing = new VerificationService(racingClient, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    expect(await system(() => racing.expireLapsedDocuments())).toBe(0);
    expect(raced).toBe(true);
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: old } }))).toMatchObject({ state: 'SUPERSEDED' });
    expect(await system(() => app.prisma.documentRecord.findUnique({ where: { submissionId: renewal.id } }))).toMatchObject({ status: 'VALID' });
  });

  it('rolls back a failed document projection, expires an unrelated row, then recovers the failed document', async () => {
    const owner = await user();
    const poisonDoc = await committed(owner, 20); await lapse(poisonDoc);
    const provider = await system(() => app.prisma.serviceProvider.create({ data: { userId: owner, trade: 'plumber', isVerified: true } }));
    const legal = await pending(await user(), 'INFO_REQUESTED');
    const failing = new VerificationService(poisonedProvider(provider.id), new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    await expect(system(() => failing.expireLapsedDocuments())).rejects.toMatchObject({
      completed: 1, counts: { provider_reconcile: 1, document_expiry: 1 },
    });
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: poisonDoc } }))).toMatchObject({ state: 'COMMITTED' });
    expect(await system(() => app.prisma.documentRecord.findUnique({ where: { submissionId: poisonDoc } }))).toMatchObject({ status: 'VALID' });
    expect(await system(() => app.prisma.renewalSchedule.findUnique({ where: { documentId: poisonDoc } }))).toMatchObject({ suspendedAt: null });
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: legal } }))).toMatchObject({ state: 'EXPIRED' });
    expect(await system(() => service.expireLapsedDocuments())).toBe(1);
    expect(await system(() => app.prisma.documentRecord.findUnique({ where: { submissionId: poisonDoc } }))).toMatchObject({ status: 'EXPIRED' });
  });

  it('keeps exact failure totals with at most ten samples across provider cursor pages', async () => {
    const poisonIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const userId = await user();
      const p = await system(() => app.prisma.serviceProvider.create({ data: { userId, trade: 'plumber', isVerified: true } }));
      poisonIds.push(p.id);
    }
    let failure: unknown;
    try { await system(() => reconcileProviderVerifications(poisonedProvider(...poisonIds), 2)); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ completed: 0, counts: { provider_reconcile: 12 }, samples: expect.any(Array) });
    expect((failure as { samples: unknown[] }).samples).toHaveLength(10);
    expect(await system(() => reconcileProviderVerifications(app.prisma, 2))).toBe(12);
  });

  it.each(['throw', 'empty receipt'] as const)('continues after an expiry notice %s and replays the terminal row without a false new-expiry count', async (mode) => {
    const first = await pending(await user(), 'REVIEW_QUEUED');
    const later = await pending(await user(), 'IN_REVIEW');
    const notifications = new NotificationService(app.prisma, app.io);
    const realSend = notifications.send.bind(notifications);
    const send = vi.spyOn(notifications, 'send').mockImplementation(async (payload) => {
      if (payload.data?.['docId'] === first) {
        if (mode === 'throw') throw new Error('synthetic notice failure');
        return '';
      }
      return realSend(payload);
    });
    const failing = new VerificationService(app.prisma, notifications, new SandboxKycProvider());
    await expect(system(() => failing.expireLapsedDocuments())).rejects.toMatchObject({ completed: 2, counts: { expiry_effects: 1 } });
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: first } }))).toMatchObject({ state: 'EXPIRED' });
    expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: later } }))).toMatchObject({ state: 'EXPIRED' });
    send.mockRestore();
    expect(await system(() => failing.expireLapsedDocuments())).toBe(0);
    expect(await system(() => failing.expireLapsedDocuments())).toBe(0);
    for (const id of [first, later]) {
      expect(await system(() => app.prisma.notification.count({ where: {
        AND: [{ data: { path: ['kind'], equals: 'verification_expired' } }, { data: { path: ['docId'], equals: id } }],
      } }))).toBe(1);
    }
  });

  it('the installed expiry processor reaches reminders, retention and audit before failing honestly for retry', async () => {
    const { createWorkers } = await import('../jobs/queue');
    const { ComplianceAuditService } = await import('../modules/verification/compliance-audit.service');
    const providerUser = await user();
    const provider = await system(() => app.prisma.serviceProvider.create({ data: { userId: providerUser, trade: 'plumber', isVerified: true } }));
    const legal = await pending(await user(), 'IN_REVIEW');
    const reminders = vi.spyOn(VerificationService.prototype, 'sendExpiryReminders').mockResolvedValue(0);
    const purge = vi.spyOn(VerificationService.prototype, 'purgeExpiredDocuments').mockResolvedValue(0);
    vi.spyOn(VerificationService.prototype, 'alertReviewSlaBreaches').mockResolvedValue(0);
    const audit = vi.spyOn(ComplianceAuditService.prototype, 'runAudit').mockResolvedValue({ moversChecked: 0, violations: 0 } as never);
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const context = { prisma: poisonedProvider(provider.id), redis: app.redis, io: app.io, log: log as never };
    const workers = await createWorkers(context, {} as never);
    try {
      const process = (workers.verificationWorker as unknown as { processor: (job: { name: string }) => Promise<void> }).processor;
      await expect(system(() => process({ name: 'expiry-sweep' }))).rejects.toMatchObject({ code: 'VERIFICATION_SWEEP_INCOMPLETE' });
      expect(reminders).toHaveBeenCalledTimes(1); expect(purge).toHaveBeenCalledTimes(1); expect(audit).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ counts: { provider_reconcile: 1 }, expired: 1 }), expect.any(String));
      expect(await system(() => app.prisma.verificationDocument.findUnique({ where: { id: legal } }))).toMatchObject({ state: 'EXPIRED' });
      context.prisma = app.prisma;
      await expect(system(() => process({ name: 'expiry-sweep' }))).resolves.toBeUndefined();
      expect(audit).toHaveBeenCalledTimes(2);
      expect(await system(() => app.prisma.serviceProvider.findUnique({ where: { id: provider.id } }))).toMatchObject({ isVerified: false });
    } finally { await workers.cleanup(); }
  });
});
