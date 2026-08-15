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
}

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
    const kase = staged.kase;

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
  }> {
    // Subject-level serialization keeps concurrent intake/lift decisions in a
    // total order. The case, final severity/SLA, dispatch exclusion, interim
    // action, and due-process inbox evidence all commit or all roll back.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.subjectUserId} FOR UPDATE`;
    let severity = initialSeverity;
    let patternFrom: IncidentSeverity | null = null;
    if (['S0', 'S1', 'S2'].includes(initialSeverity)) {
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
        details: (input.details ?? undefined) as never,
        slaAckBy: new Date(now.getTime() + ackMin * 60_000),
        slaDecideBy: new Date(now.getTime() + decideMin * 60_000),
        patternFlaggedAt: patternFrom ? now : null,
        createdAt: now,
      },
    });

    let suspensionNotificationId: string | null = null;
    if ((severity === 'S0' || severity === 'S1') && autoSuspendEnabled()) {
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
    return { kase, patternFrom, suspensionNotificationId };
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
  async escalatePolice(id: string, opsUserId: string): Promise<IncidentCase> {
    const kase = await this.prisma.incidentCase.findUnique({ where: { id } });
    if (!kase) throw new NotFoundError('IncidentCase', id);
    if (kase.status === 'CLOSED' && !kase.escalatedPoliceAt) {
      throw new AppError(409, 'CASE_CLOSED', 'Reopen handling happens with ops — a closed case cannot newly escalate.');
    }
    if (kase.escalatedPoliceAt) return kase;
    const updated = await this.prisma.incidentCase.update({
      where: { id },
      data: { escalatedPoliceAt: new Date(), legalHold: true, details: { ...((kase.details as Record<string, unknown> | null) ?? {}), policeEscalatedBy: opsUserId } as never },
    });
    // §9.2 — police escalation puts the linked evidence bundle under legal
    // hold too (retention must never delete what a prosecution may need).
    const { EvidenceService } = await import('./evidence.service');
    const evidence = new EvidenceService(this.prisma, this.io);
    const bundle = await this.prisma.evidenceBundle.findUnique({ where: { caseId: id }, select: { id: true } });
    if (bundle) await evidence.setLegalHold(bundle.id, opsUserId, `Case ${kase.caseNumber} escalated to police`).catch(() => {});
    log().warn({ caseId: id, opsUserId }, 'incident escalated to police — legal hold set');
    return updated;
  }

  // ── Sweeps (§8.2 SLA watch · §8.4 nightly pattern · weekly digest) ───────

  /** Every live case whose ack or decide clock has blown. Pure read — the
   *  queue handler pages ops (opsPageOnce keeps it one page per case per
   *  window, re-paging while the breach persists). */
  async slaWatch(now = new Date()): Promise<Array<{ id: string; caseNumber: string; severity: IncidentSeverity; kind: 'ACK' | 'DECIDE' }>> {
    const live = await this.prisma.incidentCase.findMany({
      where: {
        status: { not: 'CLOSED' },
        OR: [
          { ackedAt: null, slaAckBy: { lt: now } },
          { decidedAt: null, slaDecideBy: { lt: now } },
        ],
      },
      select: { id: true, caseNumber: true, severity: true, ackedAt: true, slaAckBy: true, decidedAt: true, slaDecideBy: true },
      take: 200,
    });
    const breaches: Array<{ id: string; caseNumber: string; severity: IncidentSeverity; kind: 'ACK' | 'DECIDE' }> = [];
    for (const k of live) {
      if (!k.ackedAt && k.slaAckBy < now) breaches.push({ id: k.id, caseNumber: k.caseNumber, severity: k.severity, kind: 'ACK' });
      if (!k.decidedAt && k.slaDecideBy < now) breaches.push({ id: k.id, caseNumber: k.caseNumber, severity: k.severity, kind: 'DECIDE' });
    }
    return breaches;
  }

  /** §8.4 rule 2 (nightly): ≥3 reports from DIFFERENT reporters in 365 days,
   *  regardless of severity — three "made me uncomfortable" from three
   *  different women is a signal with zero convictions. Stamps the subject's
   *  newest unstamped case; idempotent across runs. */
  async crossReporterScan(now = new Date()): Promise<Array<{ subjectUserId: string; distinctReporters: number; caseNumber: string }>> {
    const rows = await this.prisma.incidentCase.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 365 * 86_400_000) }, reporterUserId: { not: null } },
      select: { subjectUserId: true, reporterUserId: true },
      take: 5000,
    });
    const bySubject = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = bySubject.get(r.subjectUserId) ?? new Set<string>();
      set.add(r.reporterUserId!);
      bySubject.set(r.subjectUserId, set);
    }
    const flagged: Array<{ subjectUserId: string; distinctReporters: number; caseNumber: string }> = [];
    for (const [subjectUserId, reporters] of bySubject) {
      if (reporters.size < 3) continue;
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
    const openCases = await this.prisma.incidentCase.findMany({
      where: { status: { not: 'CLOSED' } },
      select: { severity: true, subjectUserId: true },
      take: 2000,
    });
    const bySeverity = new Map<string, number>();
    for (const k of openCases) bySeverity.set(k.severity, (bySeverity.get(k.severity) ?? 0) + 1);
    const breaches = (await this.slaWatch(now)).length;
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
