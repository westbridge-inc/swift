import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { ComplianceAuditService } from '../modules/verification/compliance-audit.service';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// Compliance audit — the liability shield. The invariant: nobody live-operates
// with a broken document checklist; every check leaves evidence.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: ComplianceAuditService;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
const runIds: string[] = [];
let seq = 0;

/** Wrap runAudit so every run row this file creates is cleaned up after. */
async function runAudit(trigger: 'SCHEDULED' | 'MANUAL') {
  const run = await svc.runAudit(trigger);
  runIds.push(run.id);
  return run;
}

async function makeMover(opts: { docStatus?: 'APPROVED' | 'EXPIRED' | 'REJECTED'; docExpiresAt?: Date | null; online?: boolean; legacyDriver?: boolean; lastActiveAt?: Date }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59268${marker.slice(0, 2).charCodeAt(0) % 9}${String(seq).padStart(4, '0')}`,
      firstName: 'Comp', lastName: `M${seq}`,
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true,
      countryCode: 'GY',
      lastActiveAt: opts.lastActiveAt ?? new Date(),
    },
  });
  userIds.push(user.id);

  if (opts.legacyDriver) {
    await app.prisma.driver.create({
      data: {
        userId: user.id,
        vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
        licensePlate: `P${marker}${seq}`,
        driverLicenseUrl: `/uploads/test/${marker}-dl.jpg`,
        vehicleInsuranceUrl: `/uploads/test/${marker}-ins.jpg`,
        isOnline: opts.online ?? true,
        locationSessionId: syntheticLocationOwner('compliance-driver'),
        documentsVerified: true, // legacy grandfathered
      },
    });
    return user;
  }

  await app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      isOnline: opts.online ?? true,
      locationSessionId: syntheticLocationOwner('compliance-rider'),
    },
  });

  if (opts.docStatus) {
    // The GY MOTORCYCLE checklist (MOVER base + MOVER_MOTOR) — one document
    // per required type so a compliant mover truly passes the real gate.
    const config = await app.prisma.countryConfig.findUnique({ where: { code: 'GY' } });
    const checklists = (config?.documentChecklists ?? {}) as Record<string, string[]>;
    const required: string[] = [...(checklists['MOVER'] ?? ['national_id']), ...(checklists['MOVER_MOTOR'] ?? [])];
    for (const docType of required) {
      await app.prisma.verificationDocument.create({
        data: {
          userId: user.id,
          role: 'MOVER',
          docType,
          fileUrl: `test/${marker}/${docType}`,
          status: opts.docStatus,
          expiresAt: opts.docExpiresAt === undefined ? new Date(Date.now() + 365 * 24 * 3600 * 1000) : opts.docExpiresAt,
        },
      });
    }
  }
  return user;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();

  const notifications = new NotificationService(app.prisma, app.io);
  const verification = new VerificationService(app.prisma, notifications, getKycProvider());
  svc = new ComplianceAuditService(app.prisma, notifications, verification);
});

afterAll(async () => {
  if (runIds.length > 0) {
    await app.prisma.complianceAuditRun.deleteMany({ where: { id: { in: runIds } } });
  }
  if (userIds.length > 0) {
    await app.prisma.complianceViolation.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.complianceReviewCase.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('runAudit — the invariant check', () => {
  it('forces an online mover with an EXPIRED checklist offline and records evidence', async () => {
    const bad = await makeMover({ docStatus: 'EXPIRED', online: true });

    const run = await runAudit('MANUAL');
    expect(run.moversChecked).toBeGreaterThanOrEqual(1);
    expect(run.finishedAt).toBeTruthy();

    const rider = await app.prisma.rider.findUnique({ where: { userId: bad.id } });
    expect(rider?.isOnline).toBe(false);

    const violation = await app.prisma.complianceViolation.findFirst({ where: { userId: bad.id } });
    expect(violation).toBeTruthy();
    expect(violation?.runId).toBe(run.id);
    expect(violation?.actionTaken).toBe('FORCED_OFFLINE');
    const evidence = violation?.evidence as { documents: Array<{ status: string }> };
    expect(evidence.documents.length).toBeGreaterThan(0);
    expect(evidence.documents.every((d) => d.status === 'EXPIRED')).toBe(true);
  });

  it('leaves a fully compliant online mover untouched', async () => {
    const good = await makeMover({ docStatus: 'APPROVED', online: true });

    await runAudit('MANUAL');

    const rider = await app.prisma.rider.findUnique({ where: { userId: good.id } });
    expect(rider?.isOnline).toBe(true);
    expect(await app.prisma.complianceViolation.count({ where: { userId: good.id } })).toBe(0);
  });

  it('flags a legacy taxi driver WITHOUT confirmed HIRE insurance (insurance never grandfathers)', async () => {
    const uninsured = await makeMover({ legacyDriver: true, online: true });

    await runAudit('MANUAL');

    const driver = await app.prisma.driver.findUnique({ where: { userId: uninsured.id } });
    expect(driver?.isOnline).toBe(false);
    const violation = await app.prisma.complianceViolation.findFirst({ where: { userId: uninsured.id } });
    expect(violation?.reason).toBe('insurance');
  });

  it('leaves a legacy taxi driver WITH confirmed HIRE insurance online', async () => {
    const insured = await makeMover({ legacyDriver: true, online: true });
    await app.prisma.verificationDocument.create({
      data: {
        userId: insured.id,
        role: 'MOVER',
        docType: 'vehicle_insurance',
        fileUrl: `test/${marker}/hire-ins`,
        status: 'APPROVED',
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        coverageClass: 'HIRE',
        hireClassConfirmed: true,
        plateCrossChecked: true,
        reviewedAt: new Date(),
      },
    });

    await runAudit('MANUAL');

    const driver = await app.prisma.driver.findUnique({ where: { userId: insured.id } });
    expect(driver?.isOnline).toBe(true);
    expect(await app.prisma.complianceViolation.count({ where: { userId: insured.id } })).toBe(0);
  });

  it('writes an audit-run row even when there is nothing to flag (evidence of checking)', async () => {
    const before = await app.prisma.complianceAuditRun.count();
    await runAudit('SCHEDULED');
    expect(await app.prisma.complianceAuditRun.count()).toBe(before + 1);
  });
});

describe('sampleForReview — random re-verification', () => {
  it('queues recently-active movers and never duplicates an OPEN case', async () => {
    await makeMover({ docStatus: 'APPROVED', online: false });
    await makeMover({ docStatus: 'APPROVED', online: false });

    const first = await svc.sampleForReview(500);
    expect(first).toBeGreaterThanOrEqual(2);

    // Re-sampling immediately can only add movers not already OPEN — our two
    // must not be duplicated.
    await svc.sampleForReview(500);
    for (const id of userIds.slice(-2)) {
      expect(await app.prisma.complianceReviewCase.count({ where: { userId: id, status: 'OPEN' } })).toBeLessThanOrEqual(1);
    }
  });

  it('FAIL decision pulls the mover offline and records a violation; double-decide rejects', async () => {
    const target = await makeMover({ docStatus: 'APPROVED', online: true });
    const kase = await app.prisma.complianceReviewCase.create({
      data: { userId: target.id, dueAt: new Date() },
    });

    const decided = await svc.decideReview(kase.id, 'admin-test', false, 'documents look forged');
    expect(decided.status).toBe('FAILED');

    const rider = await app.prisma.rider.findUnique({ where: { userId: target.id } });
    expect(rider?.isOnline).toBe(false);
    expect(await app.prisma.complianceViolation.count({ where: { userId: target.id, reason: 'manual_review_failed' } })).toBe(1);

    await expect(svc.decideReview(kase.id, 'admin-test', true)).rejects.toThrow(/already decided/i);
  });

  it('PASS decision closes the case and touches nothing else', async () => {
    const target = await makeMover({ docStatus: 'APPROVED', online: true });
    const kase = await app.prisma.complianceReviewCase.create({
      data: { userId: target.id, dueAt: new Date() },
    });
    const decided = await svc.decideReview(kase.id, 'admin-test', true, 'all good');
    expect(decided.status).toBe('PASSED');
    const rider = await app.prisma.rider.findUnique({ where: { userId: target.id } });
    expect(rider?.isOnline).toBe(true);
  });
});

describe('resolveViolation', () => {
  it('refuses to resolve while the checklist still fails, resolves once it passes', async () => {
    const mover = await makeMover({ docStatus: 'EXPIRED', online: true });
    await runAudit('MANUAL');
    const violation = await app.prisma.complianceViolation.findFirstOrThrow({ where: { userId: mover.id } });

    await expect(svc.resolveViolation(violation.id)).rejects.toThrow(/still fails/i);

    // Documents renewed → resolvable. [DOC-1 P5-1] A renewal is a NEW approved submission;
    // an EXPIRED document never returns to APPROVED (the machine refuses EXPIRED → APPROVED).
    const lapsed = await app.prisma.verificationDocument.findMany({ where: { userId: mover.id } });
    await app.prisma.verificationDocument.createMany({ data: lapsed.map((d) => ({
      userId: d.userId, role: d.role, docType: d.docType, fileUrl: `${d.fileUrl}-renewed`,
      status: 'APPROVED' as const, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    })) });
    const resolved = await svc.resolveViolation(violation.id);
    expect(resolved.resolvedAt).toBeTruthy();
  });
});
