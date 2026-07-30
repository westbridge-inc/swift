import type { PrismaClient, IncidentSeverity, IncidentStatus, IncidentIntake, IncidentCase } from '@prisma/client';
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

export class IncidentService {
  private notifications: NotificationService;

  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** Open a case from any intake surface. Applies the §8.3 interim action for
   *  S0/S1, runs the §8.4 on-intake pattern hook, pages ops. */
  async intake(input: IncidentIntakeInput): Promise<IncidentCase> {
    const severity = input.severity ?? CATEGORY_SEVERITY[input.category] ?? 'S3';
    const [ackMin, decideMin] = SLA_MINUTES[severity];
    const now = new Date();

    let kase = await this.prisma.incidentCase.create({
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
      },
    });

    // §8.3 interim — movers vanish from dispatch instantly (availability is
    // the source of truth); active trips are allowed to complete (we do NOT
    // null current ride/order pointers — ops can kill a trip explicitly).
    if ((severity === 'S0' || severity === 'S1') && autoSuspendEnabled()) {
      const suspended = await this.applyInterimSuspension(input.subjectUserId, now);
      if (suspended) {
        kase = await this.prisma.incidentCase.update({ where: { id: kase.id }, data: { interimAction: 'SUSPENDED_PENDING_REVIEW' } });
        // Due process: reason CATEGORY only — never the reporter — plus the
        // appeal path.
        await this.notifications.send({
          userId: input.subjectUserId,
          type: 'SAFETY',
          title: 'Account suspended pending review',
          body: `A ${this.categoryLabel(input.category)} report is under review on your account. You are offline while our safety team reviews it — contact support to respond.`,
          data: { kind: 'incident_interim_suspension', caseNumber: kase.caseNumber, category: input.category },
        });
      }
    }

    kase = await this.patternHook(kase);

    const siren = severity === 'S0' || severity === 'S1' ? '🚨 ' : '';
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

  /** §8.4 on-intake hook: same subject, ≥2 S2+ cases in 180 days → escalate
   *  one band + PATTERN banner. (The nightly cross-reporter rule and the
   *  weekly digest ride the next slice.) */
  private async patternHook(kase: IncidentCase): Promise<IncidentCase> {
    if (!['S0', 'S1', 'S2'].includes(kase.severity)) return kase;
    const priors = await this.prisma.incidentCase.count({
      where: {
        subjectUserId: kase.subjectUserId,
        id: { not: kase.id },
        severity: { in: ['S0', 'S1', 'S2'] },
        createdAt: { gte: new Date(Date.now() - 180 * 86_400_000) },
      },
    });
    if (priors === 0) return kase;
    const bumped: IncidentSeverity = kase.severity === 'S2' ? 'S1' : 'S0';
    const [ackMin, decideMin] = SLA_MINUTES[bumped];
    const updated = await this.prisma.incidentCase.update({
      where: { id: kase.id },
      data: {
        severity: bumped,
        patternFlaggedAt: new Date(),
        slaAckBy: new Date(kase.createdAt.getTime() + ackMin * 60_000),
        slaDecideBy: new Date(kase.createdAt.getTime() + decideMin * 60_000),
      },
    });
    log().warn({ caseId: kase.id, subjectUserId: kase.subjectUserId, from: kase.severity, to: bumped }, 'incident pattern escalation — repeat S2+ subject');
    try {
      this.io.to('ops:war-room').emit('incident:pattern', { caseId: kase.id, caseNumber: kase.caseNumber, severity: bumped });
    } catch { /* advisory only */ }
    return updated;
  }

  private async applyInterimSuspension(userId: string, now: Date): Promise<boolean> {
    // Movers are the dispatch-visible risk; vendor/customer subjects keep the
    // existing suspension/strike tools (an ops decision, not an auto one).
    const d = await this.prisma.driver.updateMany({ where: { userId }, data: { safetySuspendedAt: now, isOnline: false, isAvailable: false } });
    const r = await this.prisma.rider.updateMany({ where: { userId }, data: { safetySuspendedAt: now, isOnline: false, isAvailable: false } });
    return d.count > 0 || r.count > 0;
  }

  /** Explicit, audited lift — also runs automatically on a DISMISSED decision. */
  async liftInterim(id: string, opsUserId: string): Promise<IncidentCase> {
    const kase = await this.prisma.incidentCase.findUnique({ where: { id } });
    if (!kase) throw new NotFoundError('IncidentCase', id);
    await this.prisma.driver.updateMany({ where: { userId: kase.subjectUserId }, data: { safetySuspendedAt: null } });
    await this.prisma.rider.updateMany({ where: { userId: kase.subjectUserId }, data: { safetySuspendedAt: null } });
    const updated = await this.prisma.incidentCase.update({
      where: { id },
      data: { interimAction: 'NONE', details: { ...((kase.details as Record<string, unknown> | null) ?? {}), interimLiftedBy: opsUserId, interimLiftedAt: new Date().toISOString() } as never },
    });
    await this.notifications.send({
      userId: kase.subjectUserId,
      type: 'SAFETY',
      title: 'Suspension lifted',
      body: 'The interim suspension on your account has been lifted. You can go back online.',
      data: { kind: 'incident_interim_lifted', caseNumber: kase.caseNumber },
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
    if (decisionCode === 'DISMISSED' && decided.interimAction === 'SUSPENDED_PENDING_REVIEW') {
      return this.liftInterim(id, opsUserId); // a dismissed case must not leave someone suspended
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
    log().warn({ caseId: id, opsUserId }, 'incident escalated to police — legal hold set');
    return updated;
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
