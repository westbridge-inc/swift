import type {
  Prisma,
  PrismaClient,
  IncidentSeverity,
  IncidentStatus,
  IncidentIntake,
  IncidentCase,
} from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { sweepPage } from '../../lib/sweep-cursor';
import { createHash } from 'node:crypto';
import { incidentIntakeCounter, incidentIntakeGauge } from '../../plugins/observability';
import { placeLegalHold, drainLegalHoldVault, type LegalHoldObserver } from './legal-hold';

// Incident Management (safety spec §8) — the case machine. Server-owned like
// the order and SOS machines: explicit transition table, CAS updates, illegal
// moves rejected and logged. SLA clocks are stamped AT INTAKE from severity —
// the breach queue is an indexed read, never a recomputation.
//
//   OPEN → TRIAGED → INVESTIGATING → DECIDED → CLOSED
//   any (not CLOSED) → escalate-police: a PARALLEL flag that sets legalHold —
//   the case keeps moving through the same machine.
//
// §8.5 reporter protection is structural: reporterUserId exists on the row,
// but nothing subject-facing ever includes it — notifications carry the
// category only, plus the appeal path (due process, §8.3).

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['TRIAGED'],
  TRIAGED: ['INVESTIGATING', 'DECIDED'], // a clear-cut case may be decided at triage
  INVESTIGATING: ['DECIDED'],
  DECIDED: ['CLOSED'],
  CLOSED: [],
};

/** §8.1 — category → default severity; ops can override at intake. */
export const CATEGORY_SEVERITY: Record<string, IncidentSeverity> = {
  SAFETY_ASSAULT: 'S0',
  SAFETY_THREAT: 'S1',
  IDENTITY_MISMATCH: 'S1',
  MOVER_SESSION_LOST_IN_CUSTODY: 'S1',
  SAFETY_HARASSMENT: 'S2',
  DRIVING_DANGEROUS: 'S2',
  CASH_DISPUTE: 'S3',
  COMPLETION_ANOMALY: 'S3',
  SERVICE_QUALITY: 'S4',
  OTHER: 'S3',
};

/** §8.2 SLA clocks per severity: [ack minutes, decide minutes]. */
const SLA_MINUTES: Record<IncidentSeverity, [number, number]> = {
  S0: [5, 24 * 60],
  S1: [60, 48 * 60],
  S2: [12 * 60, 5 * 24 * 60],
  S3: [24 * 60, 10 * 24 * 60],
  S4: [24 * 60, 10 * 24 * 60],
};

/** §8.3 — S0/S1 credible report auto-suspends at intake. Per-tenant flag,
 *  default ON. */
const autoSuspendEnabled = () => process.env['INCIDENT_AUTO_SUSPEND'] !== '0';

export const DECISION_CODES = ['DISMISSED', 'WARNING_ISSUED', 'SUSPENSION_PERMANENT', 'RESOLVED_OTHER'] as const;

/** Go-online gate for §8.3 interim suspension — unconditional (a safety
 *  suspension is an explicit action, exactly like a liveness lock). */
export function assertNotSafetySuspended(row: { safetySuspendedAt: Date | null }): void {
  if (row.safetySuspendedAt) {
    throw new AppError(423, 'SAFETY_SUSPENDED', 'Your account is suspended pending a safety review — contact support to respond.');
  }
}

export interface IncidentIntakeInput {
  category: string;
  /** Ops override; otherwise auto-suggested from the category. */
  severity?: IncidentSeverity;
  intake: IncidentIntake;
  subjectUserId: string;
  reporterUserId?: string | null;
  orderId?: string | null;
  sosAlertId?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  /** [S-08] The source this intake comes from — one source, one case. A
   *  retried intake with the same source returns the existing case and
   *  changes nothing: no second case, no pattern contribution, no enforcement. */
  source?: { type: string; id: string } | null;
}

/** [S-08] The fingerprint the database refuses to see twice. */
export function intakeFingerprint(source: { type: string; id: string }): string {
  return createHash('sha256').update(`${source.type}:${source.id}`).digest('hex');
}

/** [S-08 · rollback] Intake to the review queue: cases are created but no
 *  automatic enforcement (no interim suspension, no pattern escalation) is
 *  derived from them until a human reviews. */
export const intakeReviewOnly = (env: Record<string, string | undefined> = process.env) => env['INCIDENT_INTAKE_REVIEW_ONLY'] === '1';

/**
 * Durable, transaction-safe intake for the objective event where a mover's
 * authenticated authority disappears while the platform still records them
 * as holding a passenger, parcel, or prepared order.
 *
 * This cannot call IncidentService.intake(): that method intentionally owns
 * post-commit sockets and provider notifications, while session revocation
 * must commit the authority change, interim safety lock, case, and due-process
 * inbox row atomically. The mover-revocation outbox performs the retryable
 * realtime fan-out and evidence-vault capture after this transaction commits.
 */
export async function persistMoverCustodyLossIncidentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    incidentId: string;
    caseNumber: string;
    subjectNotificationId: string;
    eventId: string;
    tenantId: string;
    subjectUserId: string;
    orderId: string;
    orderNumber: string;
    pool: 'RIDER' | 'DRIVER';
    status: string;
    summary: string;
    now: Date;
  },
): Promise<IncidentCase> {
  // Shared subject-level authority lock. IncidentService intake/lift uses the
  // same row, so a concurrent all-clear can never erase this new suspension.
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.subjectUserId} FOR UPDATE`;
  const priorHighSeverityCases = await tx.incidentCase.count({
    where: {
      subjectUserId: input.subjectUserId,
      severity: { in: ['S0', 'S1', 'S2'] },
      createdAt: { gte: new Date(input.now.getTime() - 180 * 86_400_000) },
    },
  });
  const severity: IncidentSeverity = priorHighSeverityCases > 0 ? 'S0' : 'S1';
  const [ackMin, decideMin] = SLA_MINUTES[severity];

  // This is objective custody/authority evidence, not a subjective report:
  // always block a fresh GO until ops explicitly resolves the case. The live
  // assignment remains intact so suspension never strands physical custody.
  await tx.driver.updateMany({
    where: { userId: input.subjectUserId },
    data: { safetySuspendedAt: input.now, isOnline: false, isAvailable: false },
  });
  await tx.rider.updateMany({
    where: { userId: input.subjectUserId },
    data: { safetySuspendedAt: input.now, isOnline: false, isAvailable: false },
  });

  const kase = await tx.incidentCase.upsert({
    where: { id: input.incidentId },
    create: {
      id: input.incidentId,
      tenantId: input.tenantId,
      caseNumber: input.caseNumber,
      status: 'OPEN',
      severity,
      category: 'MOVER_SESSION_LOST_IN_CUSTODY',
      intake: 'SYSTEM_AUTO',
      subjectUserId: input.subjectUserId,
      reporterUserId: null,
      orderId: input.orderId,
      summary: input.summary,
      details: {
        source: 'mover_session_revocation',
        eventId: input.eventId,
        pool: input.pool,
        orderNumber: input.orderNumber,
        status: input.status,
        appealPath: 'Contact Swift support to respond to the safety review.',
      },
      legalHold: false,
      slaAckBy: new Date(input.now.getTime() + ackMin * 60_000),
      slaDecideBy: new Date(input.now.getTime() + decideMin * 60_000),
      interimAction: 'SUSPENDED_PENDING_REVIEW',
      patternFlaggedAt: priorHighSeverityCases > 0 ? input.now : null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    update: {},
  });

  await tx.notification.createMany({
    data: [{
      id: input.subjectNotificationId,
      userId: input.subjectUserId,
      type: 'SAFETY',
      title: 'Account suspended pending review',
      body: 'Your session ended while an active passenger or order remained in your custody. You are offline while our safety team reviews it — contact Swift support to respond.',
      data: {
        kind: 'incident_interim_suspension',
        eventId: input.eventId,
        caseNumber: input.caseNumber,
        category: 'MOVER_SESSION_LOST_IN_CUSTODY',
        orderId: input.orderId,
      },
      createdAt: input.now,
    }],
    skipDuplicates: true,
  });

  return kase;
}

export class IncidentService {
  private notifications: NotificationService;

  /** [S-09] Test seam for the hold transaction. Never set in routes. */
  holdObserver: LegalHoldObserver = {};
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** Open a case from any intake surface. Applies the §8.3 interim action for
   *  S0/S1, runs the §8.4 on-intake pattern hook, pages ops. */
  async intake(input: IncidentIntakeInput): Promise<IncidentCase> {
    const initialSeverity = input.severity ?? CATEGORY_SEVERITY[input.category] ?? 'S3';
    const now = new Date();
    const staged = await this.prisma.$transaction((tx) => this.stageIncidentIntake(
      tx,
      input,
      initialSeverity,
      now,
    ));
    return this.afterIntakeCommitted(staged, input);
  }

  /** The severity an intake starts from (the ops override, else the category's). */
  initialSeverityFor(input: IncidentIntakeInput): IncidentSeverity {
    return input.severity ?? CATEGORY_SEVERITY[input.category] ?? 'S3';
  }

  /** [S-13] The non-authoritative half of intake — pages, emits, the evidence
   *  bundle — after the case is COMMITTED. A caller that staged the case in
   *  its own transaction (the not-my-driver decision) calls this afterwards;
   *  a failure here never touches the case, which already exists. */
  async afterIntakeCommitted(staged: Awaited<ReturnType<IncidentService['stageIncidentIntake']>>, input: IncidentIntakeInput): Promise<IncidentCase> {
    const kase = staged.kase;
    if (staged.replayed) {
      // [S-08] The same source again: the first result IS the result. Nothing
      // is paged, emitted or opened a second time.
      incidentIntakeCounter.labels('replayed').inc();
      log().info({ caseId: kase.id, source: input.source }, '[S-08] incident intake replayed — existing case returned');
      return kase;
    }
    incidentIntakeCounter.labels(input.source ? 'created' : 'created_unfingerprinted').inc();

    if (staged.patternFrom) {
      log().warn(
        {
          caseId: kase.id,
          subjectUserId: kase.subjectUserId,
          from: staged.patternFrom,
          to: kase.severity,
        },
        'incident pattern escalation — repeat S2+ subject',
      );
      try {
        this.io.to('ops:war-room').emit('incident:pattern', {
          caseId: kase.id,
          caseNumber: kase.caseNumber,
          severity: kase.severity,
        });
      } catch { /* advisory only */ }
    }
    if (staged.suspensionNotificationId) {
      await this.notifications.publishPersisted(staged.suspensionNotificationId);
    }

    // §9.1 — S0/S1 cases open their evidence bundle at intake (an SOS-born
    // case adopts the alert's existing bundle). Best-effort.
    if (kase.severity === 'S0' || kase.severity === 'S1') {
      const { EvidenceService } = await import('./evidence.service');
      await new EvidenceService(this.prisma, this.io)
        .openForCase(kase.id)
        .catch((err) => log().error({ err, caseId: kase.id }, 'evidence bundle open failed — case unaffected'));
    }

    // AUDIT-FIX (siren note): read the FINAL severity, not the pre-hook local.
    const siren = kase.severity === 'S0' || kase.severity === 'S1' ? '🚨 ' : '';
    await notifyAdmins(this.prisma, this.notifications, {
      // Scoped to the case's tenant [NOC-A F45].
      tenantId: kase.tenantId ?? null,
      title: `${siren}Safety case ${kase.caseNumber} (${kase.severity})`,
      body: `${this.categoryLabel(kase.category)} — ${input.summary.slice(0, 140)}. Ack by ${kase.slaAckBy.toISOString()}.`,
      data: { kind: 'incident_new', caseId: kase.id, caseNumber: kase.caseNumber, severity: kase.severity, category: kase.category },
    }).catch(() => {});
    try {
      this.io.to('ops:war-room').emit('incident:new', {
        caseId: kase.id,
        caseNumber: kase.caseNumber,
        severity: kase.severity,
        category: kase.category,
        subjectUserId: kase.subjectUserId,
        interimAction: kase.interimAction,
        patternFlagged: kase.patternFlaggedAt != null,
        slaAckBy: kase.slaAckBy,
      });
    } catch { /* advisory only */ }
    return kase;
  }

  /** Transactional authority half of intake. Public only so deterministic
   * fault/race tests can fail after every write and prove the whole boundary
   * rolls back; callers should use intake(). */
  async stageIncidentIntake(
    tx: Prisma.TransactionClient,
    input: IncidentIntakeInput,
    initialSeverity: IncidentSeverity,
    now: Date,
  ): Promise<{
    kase: IncidentCase;
    patternFrom: IncidentSeverity | null;
    suspensionNotificationId: string | null;
    replayed: boolean;
  }> {
    // Subject-level serialization keeps concurrent intake/lift decisions in a
    // total order. The case, final severity/SLA, dispatch exclusion, interim
    // action, and due-process inbox evidence all commit or all roll back.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.subjectUserId} FOR UPDATE`;
    // [S-08] Under the subject lock, the same source is the same case: a
    // concurrent or later retry finds the first intake's committed row here
    // (and the unique fingerprint is the floor below this read).
    const fingerprint = input.source ? intakeFingerprint(input.source) : null;
    if (fingerprint) {
      const existing = await tx.incidentCase.findUnique({ where: { sourceFingerprint: fingerprint } });
      if (existing) {
        const replayed = await tx.incidentCase.update({ where: { id: existing.id }, data: { replayCount: { increment: 1 } } });
        return { kase: replayed, patternFrom: null, suspensionNotificationId: null, replayed: true };
      }
    }
    const reviewOnly = intakeReviewOnly();
    let severity = initialSeverity;
    let patternFrom: IncidentSeverity | null = null;
    if (!reviewOnly && ['S0', 'S1', 'S2'].includes(initialSeverity)) {
      const priors = await tx.incidentCase.count({
        where: {
          subjectUserId: input.subjectUserId,
          severity: { in: ['S0', 'S1', 'S2'] },
          createdAt: { gte: new Date(now.getTime() - 180 * 86_400_000) },
        },
      });
      if (priors > 0) {
        patternFrom = initialSeverity;
        severity = initialSeverity === 'S2' ? 'S1' : 'S0';
      }
    }
    const [ackMin, decideMin] = SLA_MINUTES[severity];
    let kase = await tx.incidentCase.create({
      data: {
        caseNumber: `INC-${nanoid(8).toUpperCase()}`,
        severity,
        category: input.category,
        intake: input.intake,
        subjectUserId: input.subjectUserId,
        reporterUserId: input.reporterUserId ?? null,
        orderId: input.orderId ?? null,
        sosAlertId: input.sosAlertId ?? null,
        summary: input.summary,
        details: ({ ...(input.details ?? {}), ...(reviewOnly ? { reviewQueue: true } : {}) }) as never,
        sourceType: input.source?.type ?? null,
        sourceId: input.source?.id ?? null,
        sourceFingerprint: fingerprint,
        slaAckBy: new Date(now.getTime() + ackMin * 60_000),
        slaDecideBy: new Date(now.getTime() + decideMin * 60_000),
        patternFlaggedAt: patternFrom ? now : null,
        createdAt: now,
      },
    });

    let suspensionNotificationId: string | null = null;
    if (!reviewOnly && (severity === 'S0' || severity === 'S1') && autoSuspendEnabled()) {
      // Movers vanish from dispatch instantly; active custody pointers remain
      // intact for an explicit recovery/completion workflow.
      const d = await tx.driver.updateMany({
        where: { userId: input.subjectUserId },
        data: { safetySuspendedAt: now, isOnline: false, isAvailable: false },
      });
      const r = await tx.rider.updateMany({
        where: { userId: input.subjectUserId },
        data: { safetySuspendedAt: now, isOnline: false, isAvailable: false },
      });
      if (d.count > 0 || r.count > 0) {
        kase = await tx.incidentCase.update({
          where: { id: kase.id },
          data: { interimAction: 'SUSPENDED_PENDING_REVIEW' },
        });
        // Liability evidence and due process: suspension cannot commit without
        // a durable subject notice, and reporter identity is never included.
        const notice = await tx.notification.create({
          data: {
            userId: input.subjectUserId,
            type: 'SAFETY',
            title: 'Account suspended pending review',
            body: `A ${this.categoryLabel(input.category)} report is under review on your account. You are offline while our safety team reviews it — contact support to respond.`,
            data: {
              kind: 'incident_interim_suspension',
              caseId: kase.id,
              caseNumber: kase.caseNumber,
              category: input.category,
            },
            createdAt: now,
          },
          select: { id: true },
        });
        suspensionNotificationId = notice.id;
      }
    }
    return { kase, patternFrom, suspensionNotificationId, replayed: false };
  }

  /** [S-08 · operations] Likely duplicates among cases with NO fingerprint
   *  (pre-S-08 intakes): the same subject, reporter, order and category within
   *  ten minutes. Enforcement derived from a duplicate is named, never
   *  reversed automatically — a human reviews and merges. */
  async scanDuplicateIntakes(now = new Date()): Promise<{ clusters: Array<{ survivorId: string; duplicateIds: string[]; enforcementFromDuplicate: boolean }> }> {
    const rows = await this.prisma.$queryRaw<Array<{ ids: string[]; enforced: boolean }>>`
      SELECT array_agg(c."id" ORDER BY c."createdAt") AS ids,
             bool_or(c."interimAction" <> 'NONE' OR c."patternFlaggedAt" IS NOT NULL) AS enforced
      FROM "IncidentCase" c
      WHERE c."sourceFingerprint" IS NULL AND c."status" <> 'CLOSED' AND c."createdAt" >= ${new Date(now.getTime() - 90 * 86_400_000)}
      GROUP BY c."subjectUserId", coalesce(c."reporterUserId", ''), coalesce(c."orderId", ''), c."category", date_trunc('hour', c."createdAt")
      HAVING count(*) > 1 AND max(c."createdAt") - min(c."createdAt") <= INTERVAL '10 minutes'
      LIMIT 200`;
    const clusters = rows.map((r) => {
      const [survivorId, ...duplicateIds] = r.ids;
      return { survivorId: survivorId!, duplicateIds, enforcementFromDuplicate: r.enforced };
    });
    incidentIntakeGauge.labels('duplicate_clusters').set(clusters.length);
    incidentIntakeGauge.labels('enforcement_from_duplicates').set(clusters.filter((c) => c.enforcementFromDuplicate).length);
    return { clusters };
  }

  /** [S-08] Merge is an explicit analyst action: the duplicate closes as a
   *  duplicate of the survivor, and enforcement derived from it is reversed
   *  when the survivor carries none. Never automatic. */
  async mergeDuplicate(duplicateId: string, survivorId: string, opsUserId: string): Promise<IncidentCase> {
    if (duplicateId === survivorId) throw new AppError(400, 'MERGE_SELF', 'A case cannot be merged into itself.');
    const [dup, survivor] = await Promise.all([this.prisma.incidentCase.findUnique({ where: { id: duplicateId } }), this.prisma.incidentCase.findUnique({ where: { id: survivorId } })]);
    if (!dup) throw new NotFoundError('IncidentCase', duplicateId);
    if (!survivor) throw new NotFoundError('IncidentCase', survivorId);
    if (dup.subjectUserId !== survivor.subjectUserId) throw new AppError(409, 'MERGE_SUBJECT_MISMATCH', 'Only cases about the same person can be merged.');
    if (dup.status === 'CLOSED') return dup;
    const now = new Date();
    if (dup.interimAction !== 'NONE' && survivor.interimAction === 'NONE') {
      await this.liftInterim(dup.id, opsUserId);
    }
    const merged = await this.prisma.incidentCase.update({
      where: { id: dup.id },
      data: {
        status: 'CLOSED', closedAt: now, closedBy: opsUserId, decidedAt: dup.decidedAt ?? now, decidedBy: dup.decidedBy ?? opsUserId,
        decisionCode: dup.decisionCode ?? 'DISMISSED', decisionNotes: `Duplicate of ${survivor.caseNumber} — merged by analyst`,
        patternFlaggedAt: null,
        details: ({ ...((dup.details as Record<string, unknown> | null) ?? {}), mergedInto: survivor.id, mergedAt: now.toISOString(), mergedBy: opsUserId }) as never,
      },
    });
    incidentIntakeCounter.labels('merged').inc();
    try { this.io.to('ops:war-room').emit('incident:merged', { caseNumber: dup.caseNumber, into: survivor.caseNumber }); } catch { /* advisory only */ }
    return merged;
  }

  /** Explicit, audited lift — also runs automatically on a DISMISSED decision.
   *  Clears the liveness lock too: when ops decide the person is fine, every
   *  block that existed because of this dispute is served — leaving a
   *  self-serve-impossible lock behind would strand a cleared driver. */
  async liftInterim(id: string, opsUserId: string): Promise<IncidentCase> {
    const preview = await this.prisma.incidentCase.findUnique({ where: { id }, select: { subjectUserId: true } });
    if (!preview) throw new NotFoundError('IncidentCase', id);
    const now = new Date();
    const { updated, restrictionRemains } = await this.prisma.$transaction(async (tx) => {
      // Serialize aggregate safety authority for this person. Session-loss
      // custody intake uses the same user lock, so lifting one case cannot
      // erase the stamp belonging to another active case.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${preview.subjectUserId} FOR UPDATE`;
      const kase = await tx.incidentCase.findUnique({ where: { id } });
      if (!kase) throw new NotFoundError('IncidentCase', id);

      const updated = await tx.incidentCase.update({
        where: { id },
        data: {
          interimAction: 'NONE',
          details: {
            ...((kase.details as Record<string, unknown> | null) ?? {}),
            interimLiftedBy: opsUserId,
            interimLiftedAt: now.toISOString(),
          } as never,
        },
      });
      const remaining = await tx.incidentCase.findMany({
        where: {
          subjectUserId: kase.subjectUserId,
          id: { not: id },
          status: { not: 'CLOSED' },
          interimAction: { in: ['SUSPENDED_PENDING_REVIEW', 'SHADOW_RESTRICTED'] },
        },
        select: { category: true, interimAction: true },
      });
      const suspensionRemains = remaining.some((other) => other.interimAction === 'SUSPENDED_PENDING_REVIEW');
      const shadowRestrictionRemains = remaining.some((other) => other.interimAction === 'SHADOW_RESTRICTED');
      // AUDIT-FIX (F5, 2026-08-01): clear the liveness lock ONLY when an
      // identity case is lifted and no other active identity case still owns
      // that safety authority. An unrelated dispute must never clear the §7
      // sold-account defence.
      const clearsLivenessLock = kase.category === 'IDENTITY_MISMATCH'
        && !remaining.some((other) => other.category === 'IDENTITY_MISMATCH');
      const clear: {
        safetySuspendedAt?: null;
        safetyShadowRestrictedAt?: null;
        livenessLockedAt?: null;
      } = {};
      if (!suspensionRemains) clear.safetySuspendedAt = null;
      if (!shadowRestrictionRemains) clear.safetyShadowRestrictedAt = null;
      if (clearsLivenessLock) clear.livenessLockedAt = null;
      if (Object.keys(clear).length > 0) {
        await tx.driver.updateMany({ where: { userId: kase.subjectUserId }, data: clear });
        await tx.rider.updateMany({ where: { userId: kase.subjectUserId }, data: clear });
      }
      return { updated, restrictionRemains: suspensionRemains || shadowRestrictionRemains };
    });
    await this.notifications.send({
      userId: updated.subjectUserId,
      type: 'SAFETY',
      title: restrictionRemains ? 'Safety review updated' : 'Suspension lifted',
      body: restrictionRemains
        ? 'The interim action for this case has been lifted. Another safety review remains active, so its account restrictions stay in place. Contact support to respond.'
        : 'The interim suspension on your account has been lifted. You can go back online.',
      data: {
        kind: 'incident_interim_lifted',
        caseNumber: updated.caseNumber,
        restrictionRemains,
      },
    });
    return updated;
  }

  /** §8.3 S2 option — SHADOW_RESTRICTED: the subject STAYS online but is
   *  excluded from enhanced-monitoring passengers' trips pending review
   *  (dispatch reads the profile stamp). Softer than suspension; still an
   *  audited interim action with the due-process notice. */
  async shadowRestrict(id: string, opsUserId: string): Promise<IncidentCase> {
    const preview = await this.prisma.incidentCase.findUnique({ where: { id }, select: { subjectUserId: true } });
    if (!preview) throw new NotFoundError('IncidentCase', id);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${preview.subjectUserId} FOR UPDATE`;
      const kase = await tx.incidentCase.findUnique({ where: { id } });
      if (!kase) throw new NotFoundError('IncidentCase', id);
      if (kase.status === 'CLOSED') throw new AppError(409, 'CASE_CLOSED', 'A closed case cannot apply interim actions.');
      if (kase.interimAction === 'SUSPENDED_PENDING_REVIEW') {
        throw new AppError(409, 'INTERIM_ACTION_CONFLICT', 'A safety suspension cannot be replaced by a shadow restriction.');
      }
      await tx.driver.updateMany({ where: { userId: kase.subjectUserId }, data: { safetyShadowRestrictedAt: now } });
      await tx.rider.updateMany({ where: { userId: kase.subjectUserId }, data: { safetyShadowRestrictedAt: now } });
      return tx.incidentCase.update({
        where: { id },
        data: {
          interimAction: 'SHADOW_RESTRICTED',
          details: {
            ...((kase.details as Record<string, unknown> | null) ?? {}),
            shadowRestrictedBy: opsUserId,
            shadowRestrictedAt: now.toISOString(),
          } as never,
        },
      });
    });
    await this.notifications.send({
      userId: updated.subjectUserId,
      type: 'SAFETY',
      title: 'Account under review',
      body: `A ${this.categoryLabel(updated.category)} report is under review on your account. You can keep working while our safety team reviews it — contact support to respond.`,
      data: { kind: 'incident_shadow_restricted', caseNumber: updated.caseNumber, category: updated.category },
    });
    return updated;
  }

  async ack(id: string, opsUserId: string) {
    return this.transition(id, 'TRIAGED', { ackedAt: new Date(), ackedBy: opsUserId });
  }

  async investigate(id: string, _opsUserId: string) {
    return this.transition(id, 'INVESTIGATING', {});
  }

  async decide(id: string, opsUserId: string, decisionCode: (typeof DECISION_CODES)[number], notes?: string) {
    const decided = await this.transition(id, 'DECIDED', {
      decidedAt: new Date(),
      decidedBy: opsUserId,
      decisionCode,
      decisionNotes: notes ?? null,
    });
    // AUDIT-FIX (F2, 2026-08-01): a DISMISSED decision lifts ANY interim
    // action, not only SUSPENDED_PENDING_REVIEW. A shadow-restricted subject
    // (the §8.3 S2 softer option) who is cleared was left restricted — quietly
    // losing enhanced-monitoring dispatch with no self-serve remedy.
    if (decisionCode === 'DISMISSED' && decided.interimAction !== 'NONE') {
      return this.liftInterim(id, opsUserId); // a dismissed case must not leave anyone restricted
    }
    return decided;
  }

  async close(id: string, opsUserId: string) {
    return this.transition(id, 'CLOSED', { closedAt: new Date(), closedBy: opsUserId });
  }

  /** §8.2 parallel flag — any live case; sets legalHold. Idempotent. */
  /** [S-09] Police escalation IS a legal hold: the case, every linked
   *  evidence bundle, the custody log entry and the hold row commit together
   *  or not at all; the vault manifest follows from the outbox. */
  async escalatePolice(id: string, opsUserId: string): Promise<IncidentCase> {
    const kase = await this.prisma.incidentCase.findUnique({ where: { id } });
    if (!kase) throw new NotFoundError('IncidentCase', id);
    if (kase.status === 'CLOSED' && !kase.escalatedPoliceAt) {
      throw new AppError(409, 'CASE_CLOSED', 'Reopen handling happens with ops — a closed case cannot newly escalate.');
    }
    if (kase.escalatedPoliceAt) return kase;
    const updated = await this.prisma.$transaction(async (tx) => {
      await placeLegalHold(tx, { caseId: id, placedBy: opsUserId, reason: `Case ${kase.caseNumber} escalated to police`, observer: this.holdObserver });
      return tx.incidentCase.update({
        where: { id },
        data: { escalatedPoliceAt: new Date(), details: { ...((kase.details as Record<string, unknown> | null) ?? {}), policeEscalatedBy: opsUserId } as never },
      });
    });
    // The vault operation runs from the outbox — inline now, and from the tick if this dies.
    await drainLegalHoldVault(this.prisma, { caseIds: [id] }).catch((err) => log().error({ err, caseId: id }, '[S-09] vault operation deferred to the worker'));
    log().warn({ caseId: id, opsUserId }, 'incident escalated to police — legal hold placed (case + evidence + custody log, one commit)');
    return updated;
  }

  // ── Sweeps (§8.2 SLA watch · §8.4 nightly pattern · weekly digest) ───────

  /** Every live case whose ack or decide clock has blown. Pure read — the
   *  queue handler pages ops (opsPageOnce keeps it one page per case per
   *  window, re-paging while the breach persists). */
  /** [S-05] The breach population is walked in keyset pages from a persisted
   *  cursor — every blown clock is reported within one pass whatever the
   *  backlog, never only the first 200. */
  async slaWatch(now = new Date(), opts: { pageSize?: number; cursorKey?: string; maxPages?: number } = {}): Promise<Array<{ id: string; caseNumber: string; severity: IncidentSeverity; kind: 'ACK' | 'DECIDE' }>> {
    const where = {
      status: { not: 'CLOSED' as const },
      OR: [
        { ackedAt: null, slaAckBy: { lt: now } },
        { decidedAt: null, slaDecideBy: { lt: now } },
      ],
    };
    const breaches: Array<{ id: string; caseNumber: string; severity: IncidentSeverity; kind: 'ACK' | 'DECIDE' }> = [];
    await sweepPage(this.prisma, `incident.sla${opts.cursorKey ? `:${opts.cursorKey}` : ''}`, {
      pageSize: opts.pageSize ?? Number(process.env['INCIDENT_SLA_PAGE_SIZE'] ?? 200),
      maxPages: opts.maxPages ?? Number(process.env['SWEEP_MAX_PAGES_PER_TICK'] ?? 25),
      now,
      count: (afterId) => this.prisma.incidentCase.count({ where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) } }),
      fetch: (afterId, limit) => this.prisma.incidentCase.findMany({
        where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        select: { id: true, caseNumber: true, severity: true, ackedAt: true, slaAckBy: true, decidedAt: true, slaDecideBy: true },
        take: limit,
      }),
      handle: async (k) => {
        if (!k.ackedAt && k.slaAckBy < now) breaches.push({ id: k.id, caseNumber: k.caseNumber, severity: k.severity, kind: 'ACK' });
        if (!k.decidedAt && k.slaDecideBy < now) breaches.push({ id: k.id, caseNumber: k.caseNumber, severity: k.severity, kind: 'DECIDE' });
      },
    });
    return breaches;
  }

  /** The breach count right now — a COUNT, never a capped page. */
  async slaBreachCount(now = new Date()): Promise<number> {
    return this.prisma.incidentCase.count({ where: { status: { not: 'CLOSED' }, OR: [{ ackedAt: null, slaAckBy: { lt: now } }, { decidedAt: null, slaDecideBy: { lt: now } }] } });
  }

  /** §8.4 rule 2 (nightly): ≥3 reports from DIFFERENT reporters in 365 days,
   *  regardless of severity — three "made me uncomfortable" from three
   *  different women is a signal with zero convictions. Stamps the subject's
   *  newest unstamped case; idempotent across runs. */
  async crossReporterScan(now = new Date()): Promise<Array<{ subjectUserId: string; distinctReporters: number; caseNumber: string }>> {
    // [S-05] The database groups the whole year — never the first 5000 rows.
    const since = new Date(now.getTime() - 365 * 86_400_000);
    const subjects = await this.prisma.$queryRaw<Array<{ subjectUserId: string; distinctReporters: number }>>`
      SELECT "subjectUserId", count(DISTINCT "reporterUserId")::int AS "distinctReporters"
      FROM "IncidentCase"
      WHERE "createdAt" >= ${since} AND "reporterUserId" IS NOT NULL
      GROUP BY "subjectUserId"
      HAVING count(DISTINCT "reporterUserId") >= 3`;
    const flagged: Array<{ subjectUserId: string; distinctReporters: number; caseNumber: string }> = [];
    for (const { subjectUserId, distinctReporters } of subjects) {
      const reporters = { size: distinctReporters };
      // Already a known pattern subject → nothing new to say (idempotent
      // across nights; a FRESH flag only when the subject wasn't flagged yet).
      const alreadyFlagged = await this.prisma.incidentCase.count({
        where: { subjectUserId, patternFlaggedAt: { not: null }, createdAt: { gte: new Date(now.getTime() - 365 * 86_400_000) } },
      });
      if (alreadyFlagged > 0) continue;
      const newest = await this.prisma.incidentCase.findFirst({
        where: { subjectUserId, patternFlaggedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (!newest) continue;
      await this.prisma.incidentCase.update({ where: { id: newest.id }, data: { patternFlaggedAt: now } });
      flagged.push({ subjectUserId, distinctReporters: reporters.size, caseNumber: newest.caseNumber });
      try {
        this.io.to('ops:war-room').emit('incident:pattern', { caseNumber: newest.caseNumber, subjectUserId, rule: 'CROSS_REPORTER', distinctReporters: reporters.size });
      } catch { /* advisory only */ }
    }
    return flagged;
  }

  /** §8.4 weekly digest — the founder's Monday read: open load by severity,
   *  blown SLA clocks, fresh pattern flags, top repeat subjects. */
  async weeklyDigest(now = new Date()): Promise<{ lines: string[]; open: number; breaches: number; patternsThisWeek: number }> {
    // [S-05] Counts from the database — never a capped page of rows.
    const openBySeverity = await this.prisma.incidentCase.groupBy({ by: ['severity'], where: { status: { not: 'CLOSED' } }, _count: { _all: true } });
    const bySeverity = new Map<string, number>(openBySeverity.map((r) => [r.severity as string, r._count._all]));
    const openCases = { length: openBySeverity.reduce((n, r) => n + r._count._all, 0) };
    const breaches = await this.slaBreachCount(now);
    const patternsThisWeek = await this.prisma.incidentCase.count({
      where: { patternFlaggedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
    });
    const yearSubjects = await this.prisma.incidentCase.groupBy({
      by: ['subjectUserId'],
      where: { createdAt: { gte: new Date(now.getTime() - 365 * 86_400_000) } },
      _count: { subjectUserId: true },
      orderBy: { _count: { subjectUserId: 'desc' } },
      take: 5,
    });
    const severityLine = ['S0', 'S1', 'S2', 'S3', 'S4']
      .map((s) => `${s}:${bySeverity.get(s) ?? 0}`)
      .join(' ');
    const lines = [
      `Open cases ${openCases.length} (${severityLine})`,
      `SLA breaches right now: ${breaches}`,
      `Pattern flags this week: ${patternsThisWeek}`,
      yearSubjects.length > 0
        ? `Top repeat subjects (365d): ${yearSubjects.map((s) => `${s.subjectUserId.slice(0, 8)}…×${s._count.subjectUserId}`).join(', ')}`
        : 'No repeat subjects in 365d',
    ];
    return { lines, open: openCases.length, breaches, patternsThisWeek };
  }

  private categoryLabel(category: string): string {
    return category.replace(/^SAFETY_/, '').replace(/_/g, ' ').toLowerCase();
  }

  /** The single CAS transition point — rejects and logs any illegal move. */
  private async transition(id: string, to: IncidentStatus, extra: Record<string, unknown>) {
    const kase = await this.prisma.incidentCase.findUnique({ where: { id }, select: { status: true } });
    if (!kase) throw new NotFoundError('IncidentCase', id);
    if (!INCIDENT_TRANSITIONS[kase.status].includes(to)) {
      log().warn({ caseId: id, from: kase.status, to }, 'illegal incident transition rejected');
      throw new AppError(409, 'INVALID_CASE_TRANSITION', `Cannot move a case from ${kase.status} to ${to}.`);
    }
    const clean = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    const moved = await this.prisma.incidentCase.updateMany({ where: { id, status: kase.status }, data: { status: to, ...clean } });
    if (moved.count === 0) throw new AppError(409, 'CASE_TRANSITION_RACE', 'The case changed underneath this action — retry.');
    return this.prisma.incidentCase.findUniqueOrThrow({ where: { id } });
  }
}
