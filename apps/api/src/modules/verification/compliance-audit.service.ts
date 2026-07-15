import { PrismaClient } from '@prisma/client';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { VerificationService } from './verification.service';
import { AppError, NotFoundError } from '../../utils/errors';

/**
 * Compliance audit — the liability shield (founder directive 2026-07-15).
 *
 * The ENFORCEMENT layer already exists: the go-online gate refuses movers
 * with a broken checklist, and the daily expiry sweep pulls them offline
 * when a document lapses. This service adds the AUDIT layer on top:
 *
 *  1. runAudit(): the invariant check. For every mover who is online RIGHT
 *     NOW, re-derive the live-operation gate from raw documents. Anyone
 *     online without a valid checklist (a bug, a race, manual DB surgery,
 *     a revoked approval) is forced offline on the spot, and the violation
 *     is recorded with a frozen per-document evidence snapshot. Every run
 *     writes an immutable row — proof the platform checked, even when the
 *     answer is "zero violations".
 *
 *  2. sampleForReview(): random re-verification. Monthly, a sample of
 *     active movers is queued for a HUMAN re-review of their documents
 *     regardless of expiry dates — the net for fraudulent/forged documents
 *     that pass OCR but not a second look.
 *
 * Everything here is deterministic (hard rule 1) — verification is never
 * an AI decision.
 */
export class ComplianceAuditService {
  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private verification: VerificationService,
  ) {}

  /** The invariant check over everyone currently live-operating. */
  async runAudit(trigger: 'SCHEDULED' | 'MANUAL' = 'SCHEDULED') {
    const run = await this.prisma.complianceAuditRun.create({ data: { trigger } });

    // Who is on the road right now? (drivers = taxis, riders = deliveries)
    const [drivers, riders] = await Promise.all([
      this.prisma.driver.findMany({
        where: { isOnline: true },
        select: { userId: true, documentsVerified: true },
      }),
      this.prisma.rider.findMany({
        where: { isOnline: true },
        select: { userId: true, vehicleType: true },
      }),
    ]);

    type Subject = { userId: string; moverKind: 'DRIVER' | 'RIDER'; vehicleType: 'CAR' | string; legacyVerified?: boolean };
    const subjects: Subject[] = [
      ...drivers.map((d) => ({ userId: d.userId, moverKind: 'DRIVER' as const, vehicleType: 'CAR', legacyVerified: d.documentsVerified })),
      ...riders.map((r) => ({ userId: r.userId, moverKind: 'RIDER' as const, vehicleType: r.vehicleType })),
    ];

    let violations = 0;
    for (const s of subjects) {
      const live = await this.verification.getLiveOperationStatus(s.userId, {
        vehicleType: s.vehicleType as never,
        legacyVerified: s.legacyVerified,
      });
      if (live.allowed) continue;

      violations += 1;
      // Freeze the evidence BEFORE acting: the per-document state that made
      // this mover non-compliant, as of detection.
      const docs = await this.prisma.verificationDocument.findMany({
        where: { userId: s.userId, role: 'MOVER' },
        select: { docType: true, status: true, expiresAt: true, hireClassConfirmed: true, coverageClass: true },
        orderBy: { createdAt: 'desc' },
      });
      await this.prisma.complianceViolation.create({
        data: {
          runId: run.id,
          userId: s.userId,
          moverKind: s.moverKind,
          reason: live.reason,
          evidence: {
            detectedAt: new Date().toISOString(),
            gateReason: live.reason,
            documents: docs.map((d) => ({
              docType: d.docType,
              status: d.status,
              expiresAt: d.expiresAt?.toISOString() ?? null,
              hireClassConfirmed: d.hireClassConfirmed,
              coverageClass: d.coverageClass,
            })),
          },
        },
      });
      // Same force-offline (and mover notification) the expiry sweep uses.
      await this.verification.forceMoverOfflineIfNotLive(s.userId);
    }

    const finished = await this.prisma.complianceAuditRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), moversChecked: subjects.length, violations },
    });

    if (violations > 0) {
      // A violation is an incident, not a dashboard line someone might read.
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'Compliance audit: movers forced offline',
        body: `${violations} of ${subjects.length} online movers failed the document check and were pulled offline. Review them in Compliance.`,
        data: { kind: 'compliance_violation', runId: run.id },
      });
    }

    return finished;
  }

  /**
   * Random re-verification sample. Picks up to `count` movers active in the
   * last 30 days who have no OPEN case yet; each becomes a human re-review
   * due in 7 days. Fisher–Yates on the candidate ids keeps it unbiased.
   */
  async sampleForReview(count = 10) {
    const activeSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [drivers, riders, open] = await Promise.all([
      this.prisma.driver.findMany({
        where: { user: { lastActiveAt: { gte: activeSince } } },
        select: { userId: true },
      }),
      this.prisma.rider.findMany({
        where: { user: { lastActiveAt: { gte: activeSince } } },
        select: { userId: true },
      }),
      this.prisma.complianceReviewCase.findMany({ where: { status: 'OPEN' }, select: { userId: true } }),
    ]);

    const openSet = new Set(open.map((c) => c.userId));
    const pool = [...new Set([...drivers, ...riders].map((m) => m.userId))].filter((id) => !openSet.has(id));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const picked = pool.slice(0, count);

    const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    for (const userId of picked) {
      await this.prisma.complianceReviewCase.create({ data: { userId, dueAt } });
    }
    return picked.length;
  }

  /** Admin decision on a re-review case. FAIL pulls the mover offline now. */
  async decideReview(caseId: string, adminId: string, pass: boolean, note?: string) {
    const existing = await this.prisma.complianceReviewCase.findUnique({ where: { id: caseId } });
    if (!existing) throw new NotFoundError('Review case');
    if (existing.status !== 'OPEN') throw new AppError(400, 'ALREADY_DECIDED', 'This case was already decided.');

    const updated = await this.prisma.complianceReviewCase.update({
      where: { id: caseId },
      data: { status: pass ? 'PASSED' : 'FAILED', decidedBy: adminId, decidedAt: new Date(), note },
    });

    if (!pass) {
      // Offline immediately; the admin then rejects the specific bad document
      // in Verification, which keeps them off the road until re-approved.
      await Promise.all([
        this.prisma.driver.updateMany({ where: { userId: existing.userId, isOnline: true }, data: { isOnline: false } }),
        this.prisma.rider.updateMany({ where: { userId: existing.userId, isOnline: true }, data: { isOnline: false } }),
      ]);
      await this.prisma.complianceViolation.create({
        data: {
          userId: existing.userId,
          moverKind: 'RIDER',
          reason: 'manual_review_failed',
          evidence: { caseId, note: note ?? null, decidedBy: adminId, decidedAt: new Date().toISOString() },
        },
      });
      await this.notifications.send({
        userId: existing.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Document re-check required',
        body: 'A routine review flagged your documents. You are offline until they are re-verified — please re-submit them in the app.',
        audience: 'earner',
        data: { kind: 'compliance_review_failed', caseId },
      });
    }
    return updated;
  }

  /** The admin Compliance page in one call. */
  async overview() {
    const [runs, openViolations, reviewQueue, unresolved] = await Promise.all([
      this.prisma.complianceAuditRun.findMany({ orderBy: { startedAt: 'desc' }, take: 30 }),
      this.prisma.complianceViolation.findMany({
        where: { resolvedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { user: { select: { firstName: true, lastName: true, phone: true } } },
      }),
      this.prisma.complianceReviewCase.findMany({
        where: { status: 'OPEN' },
        orderBy: { dueAt: 'asc' },
        take: 100,
        include: { user: { select: { firstName: true, lastName: true, phone: true } } },
      }),
      this.prisma.complianceViolation.count({ where: { resolvedAt: null } }),
    ]);
    return { runs, openViolations, reviewQueue, unresolvedCount: unresolved };
  }

  /** Mark a violation resolved once the mover's checklist passes again. */
  async resolveViolation(violationId: string) {
    const v = await this.prisma.complianceViolation.findUnique({ where: { id: violationId } });
    if (!v) throw new NotFoundError('Violation');
    if (v.resolvedAt) return v;

    const kind = await this.prisma.driver.findUnique({ where: { userId: v.userId }, select: { userId: true } });
    const vehicleType = kind
      ? ('CAR' as const)
      : (await this.prisma.rider.findUnique({ where: { userId: v.userId }, select: { vehicleType: true } }))?.vehicleType;
    if (!vehicleType) throw new AppError(400, 'NOT_A_MOVER', 'This user has no mover profile.');

    const live = await this.verification.getLiveOperationStatus(v.userId, { vehicleType: vehicleType as never });
    if (!live.allowed) {
      throw new AppError(400, 'STILL_NON_COMPLIANT', 'Their checklist still fails — fix the documents first.');
    }
    return this.prisma.complianceViolation.update({
      where: { id: violationId },
      data: { resolvedAt: new Date() },
    });
  }
}
