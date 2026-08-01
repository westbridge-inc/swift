import type { PrismaClient, SosStatus, SosTriggerSource, SosResolutionCode, OrderType } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

// SOS engine — the life-safety state machine (safety spec §4). Server-owned,
// exactly like the order machine: an explicit transition table, compare-and-set
// updates, illegal transitions rejected and logged. A closed app must not stop
// an escalation, so every timer (the grace deadline) is DB state, not setTimeout.
//
//   TRIGGER_PENDING ──grace elapses OR user confirms──▶ ACTIVE ──ops ack──▶ ACKNOWLEDGED ──ops resolve──▶ RESOLVED
//   TRIGGER_PENDING ──slide-to-cancel within grace────▶ CANCELLED
//
// "I'm safe now" (userSafeFlaggedAt) does NOT resolve — a coerced victim can be
// forced to tap it; only a human at ops closes an alert (§4.1 coercion doctrine).
export const SOS_TRANSITIONS: Record<SosStatus, SosStatus[]> = {
  TRIGGER_PENDING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ACKNOWLEDGED', 'RESOLVED'],
  ACKNOWLEDGED: ['RESOLVED'],
  RESOLVED: [],
  CANCELLED: [],
};

const GRACE_SECONDS = Math.min(5, Math.max(0, Number(process.env['SOS_CANCEL_GRACE_SECONDS'] ?? 3)));

export interface SosCreateInput {
  actorUserId: string;
  actorRole: string;
  orderId?: string | null;
  orderType?: OrderType | null;
  counterpartyUserId?: string | null;
  triggerSource?: SosTriggerSource;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  addressText?: string | null;
  clientCreatedAt?: Date | null;
  clientIdempotencyKey?: string | null;
  /** Skip the slide-to-cancel grace → straight to ACTIVE. For a caller whose UI
   *  has no countdown affordance and whose trigger is already a deliberate
   *  emergency (the in-ride SOS button, fired while the rider dials emergency
   *  services — a grace delay there only slows the ops page). */
  immediate?: boolean;
}

export class SosService {
  private notifications: NotificationService;
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** Raise an alert. Idempotent on clientIdempotencyKey so a retried offline
   *  trigger yields exactly one alert. Ops-raised alerts skip the grace window
   *  (a human already decided); user triggers open a short slide-to-cancel grace. */
  async create(input: SosCreateInput) {
    if (input.clientIdempotencyKey) {
      const existing = await this.prisma.sosAlert.findUnique({ where: { clientIdempotencyKey: input.clientIdempotencyKey } });
      if (existing) return existing; // replay → the original alert, never a second
    }
    const source = input.triggerSource ?? 'BUTTON';
    const opsRaised = source === 'OPS_MANUAL';
    const now = new Date();
    const skipGrace = opsRaised || input.immediate === true || GRACE_SECONDS === 0;
    const grace = skipGrace ? null : new Date(now.getTime() + GRACE_SECONDS * 1000);

    const alert = await this.prisma.sosAlert.create({
      data: {
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        orderId: input.orderId ?? null,
        orderType: input.orderType ?? null,
        counterpartyUserId: input.counterpartyUserId ?? null,
        triggerSource: source,
        status: grace ? 'TRIGGER_PENDING' : 'ACTIVE',
        graceEndsAt: grace,
        triggerLat: input.lat ?? null,
        triggerLng: input.lng ?? null,
        triggerAccuracyM: input.accuracyM ?? null,
        triggerAddressText: input.addressText ?? null,
        clientCreatedAt: input.clientCreatedAt ?? null,
        clientIdempotencyKey: input.clientIdempotencyKey ?? null,
      },
    });
    if (!grace) await this.fanOut(alert.id); // already ACTIVE (ops-raised / immediate / no-grace tenant)
    return alert;
  }

  /** TRIGGER_PENDING → ACTIVE. Called by the owner ("I need help now") and by
   *  the grace-expiry sweep. CAS so a race between the two fires the fan-out once. */
  async confirm(id: string) {
    const moved = await this.prisma.sosAlert.updateMany({
      where: { id, status: 'TRIGGER_PENDING' },
      data: { status: 'ACTIVE', graceEndsAt: null },
    });
    if (moved.count === 1) await this.fanOut(id);
    return this.prisma.sosAlert.findUniqueOrThrow({ where: { id } });
  }

  /** Slide-to-cancel — ONLY during the grace window. After ACTIVE it is impossible. */
  async cancel(id: string, reason: 'SLIDE_CANCEL' = 'SLIDE_CANCEL') {
    const moved = await this.prisma.sosAlert.updateMany({
      where: { id, status: 'TRIGGER_PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    if (moved.count === 0) throw new AppError(409, 'SOS_NOT_CANCELLABLE', 'This alert can no longer be cancelled — help is being reached.');
    return this.prisma.sosAlert.findUniqueOrThrow({ where: { id } });
  }

  /** "I'm safe now" — flags the alert, notifies ops, but NEVER resolves it. */
  async markSafe(id: string) {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundError('SosAlert', id);
    if (alert.status === 'RESOLVED' || alert.status === 'CANCELLED') return alert;
    const updated = await this.prisma.sosAlert.update({ where: { id }, data: { userSafeFlaggedAt: new Date() } });
    await notifyAdmins(this.prisma, this.notifications, {
      title: 'SOS — user marked safe (verify)',
      body: `The user on alert ${id} tapped "I'm safe". This does NOT close the case — call back to verify before resolving.`,
      data: { kind: 'sos_marked_safe', sosAlertId: id },
    }).catch(() => {});
    return updated;
  }

  /** Ops acknowledges — ACTIVE → ACKNOWLEDGED. Ops-only (enforced at the route). */
  async ack(id: string, opsUserId: string) {
    return this.transition(id, 'ACKNOWLEDGED', { acknowledgedAt: new Date(), acknowledgedBy: opsUserId });
  }

  /** Ops resolves — requires a resolution code. ACTIVE|ACKNOWLEDGED → RESOLVED.
   *  Closes the loop: the emergency contacts who were alarmed get an all-clear.
   *  ONLY ops resolution does this — "I'm safe" must NOT (a coerced victim could
   *  be forced to tap it; §4.1). Best-effort, never fails the resolve. */
  async resolve(id: string, opsUserId: string, resolutionCode: SosResolutionCode, notes?: string) {
    const resolved = await this.transition(id, 'RESOLVED', { resolvedAt: new Date(), resolvedBy: opsUserId, resolutionCode, resolutionNotes: notes ?? null });
    await this.fanOutResolved(id).catch(() => {});
    // §8.1 — an SOS ops coded as real harm doesn't end at "resolved": it opens
    // an incident case against the counterparty so investigation, interim
    // action, and pattern intelligence all engage. Best-effort: a case-intake
    // hiccup must never fail the resolve itself.
    if ((resolutionCode === 'ABUSE' || resolutionCode === 'POLICE_INVOLVED') && resolved.counterpartyUserId) {
      const { IncidentService } = await import('./incident.service');
      await new IncidentService(this.prisma, this.io)
        .intake({
          category: resolutionCode === 'POLICE_INVOLVED' ? 'SAFETY_ASSAULT' : 'SAFETY_THREAT',
          intake: 'SOS_RESOLUTION',
          subjectUserId: resolved.counterpartyUserId,
          reporterUserId: resolved.actorUserId,
          orderId: resolved.orderId,
          sosAlertId: resolved.id,
          summary: `SOS ${resolved.id} resolved by ops as ${resolutionCode}${notes ? `: ${notes.slice(0, 200)}` : ''}`,
        })
        .catch((err) => log().error({ err, sosAlertId: id }, 'SOS resolution: incident intake failed — resolve stands'));
    }
    return resolved;
  }

  /** The single CAS transition point — rejects and logs any illegal move. */
  private async transition(id: string, to: SosStatus, extra: Record<string, unknown>) {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id }, select: { status: true } });
    if (!alert) throw new NotFoundError('SosAlert', id);
    if (!SOS_TRANSITIONS[alert.status].includes(to)) {
      log().warn({ sosAlertId: id, from: alert.status, to }, 'illegal SOS transition rejected');
      throw new AppError(409, 'INVALID_SOS_TRANSITION', `Cannot move an SOS from ${alert.status} to ${to}.`);
    }
    const moved = await this.prisma.sosAlert.updateMany({ where: { id, status: alert.status }, data: { status: to, ...extra } });
    if (moved.count === 0) throw new AppError(409, 'SOS_TRANSITION_RACE', 'The alert changed underneath this action — retry.');
    return this.prisma.sosAlert.findUniqueOrThrow({ where: { id } });
  }

  /** Fan-out on ACTIVE (§4.4): ops page + war-room socket + an SMS to every
   *  VERIFIED emergency contact (§5), receipts recorded. High-frequency location
   *  streaming rides on a later slice. The counterparty is NEVER notified (don't
   *  tip off an attacker). */
  private async fanOut(id: string) {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id } });
    if (!alert || alert.status !== 'ACTIVE') return;
    const receipts: Record<string, unknown> = {};
    try {
      const n = await notifyAdmins(this.prisma, this.notifications, {
        title: '🚨 SOS ACTIVE — respond now',
        body: `${alert.actorRole} raised an SOS${alert.orderId ? ` on order ${alert.orderId}` : ''}. Location on the war-room map. Ack immediately.`,
        data: { kind: 'sos_active', sosAlertId: id, orderId: alert.orderId, lat: alert.triggerLat, lng: alert.triggerLng },
      });
      receipts['opsPaged'] = n;
    } catch (e) {
      receipts['opsPaged'] = 0;
      log().error({ err: e, sosAlertId: id }, 'SOS fan-out: ops page failed');
    }
    try {
      this.io.to('ops:war-room').emit('sos:active', { sosAlertId: id, actorRole: alert.actorRole, orderId: alert.orderId, lat: alert.triggerLat, lng: alert.triggerLng, triggeredAt: alert.triggeredAt });
      receipts['socket'] = true;
    } catch {
      receipts['socket'] = false;
    }

    // Guardian §5.3 L4: an alert born from an UNANSWERED check-in timeout is
    // the server guessing, not a human asking. Contacts are NOT auto-SMSed by
    // default — a false-positive "emergency" text to someone's mother erodes
    // the whole feature; ops decides within their SLA. Per-tenant override:
    // GUARDIAN_AUTONOTIFY_CONTACTS=1. Explicit human triggers (BUTTON, the
    // check-in "I need help" → GUARDIAN_ESCALATION) always fan out.
    if (alert.triggerSource === 'CHECKIN_TIMEOUT' && process.env['GUARDIAN_AUTONOTIFY_CONTACTS'] !== '1') {
      receipts['contacts'] = 'skipped:guardian-default';
      await this.prisma.sosAlert.update({ where: { id }, data: { deliveryReceipts: receipts as never } }).catch(() => {});
      return;
    }

    // Verified emergency contacts (§5), in priority order. Best-effort PER
    // contact — one failed send must not stop the rest. NEVER rate-limited or
    // budgeted: this is the real emergency, not the verification handshake.
    // Unverified numbers are skipped (they never proved reachable / aware).
    try {
      const contacts = await this.prisma.emergencyContact.findMany({
        where: { userId: alert.actorUserId, verifiedAt: { not: null } },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        take: 10,
      });
      if (contacts.length > 0) {
        const { getChannels } = await import('../../providers/notifications/channels');
        const sms = getChannels().sms;
        const actor = await this.prisma.user.findUnique({ where: { id: alert.actorUserId }, select: { firstName: true } });
        const who = actor?.firstName?.trim() || 'Someone you know';
        const where = alert.triggerLat != null && alert.triggerLng != null
          ? ` Last known location: https://maps.google.com/?q=${alert.triggerLat},${alert.triggerLng}.`
          : '';
        const body = `🚨 ${who} triggered an emergency SOS on Swift and may need help.${where} Please check on them and contact local emergency services if needed.`;
        const contactReceipts: Array<{ id: string; ok: boolean }> = [];
        for (const c of contacts) {
          try { await sms.sendSms(c.phoneE164, body); contactReceipts.push({ id: c.id, ok: true }); }
          catch { contactReceipts.push({ id: c.id, ok: false }); }
        }
        receipts['contacts'] = contactReceipts;
      }
    } catch (e) {
      log().error({ err: e, sosAlertId: id }, 'SOS fan-out: emergency-contact SMS failed');
    }

    await this.prisma.sosAlert.update({ where: { id }, data: { deliveryReceipts: receipts as never } }).catch(() => {});

    // §9.1 — an ACTIVE SOS opens its evidence bundle: capture what the
    // platform knows NOW, before anything moves. Best-effort; a vault hiccup
    // must never slow the fan-out that just happened.
    const { EvidenceService } = await import('./evidence.service');
    await new EvidenceService(this.prisma, this.io)
      .openForSos(id)
      .catch((err) => log().error({ err, sosAlertId: id }, 'evidence bundle open failed — alert unaffected'));
  }

  /** All-clear to the emergency contacts once ops CLOSE an alert — you don't
   *  alarm someone's contacts and then leave them in the dark. Kept deliberately
   *  neutral ("closed by our safety team", not "they're safe") so it's accurate
   *  regardless of resolution code. Merges its receipts into deliveryReceipts
   *  without clobbering the original fan-out. Only reached from resolve(). */
  private async fanOutResolved(id: string) {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id } });
    if (!alert || alert.status !== 'RESOLVED') return;
    const contacts = await this.prisma.emergencyContact.findMany({
      where: { userId: alert.actorUserId, verifiedAt: { not: null } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 10,
    });
    if (contacts.length === 0) return;
    const { getChannels } = await import('../../providers/notifications/channels');
    const sms = getChannels().sms;
    const actor = await this.prisma.user.findUnique({ where: { id: alert.actorUserId }, select: { firstName: true } });
    const who = actor?.firstName?.trim() || 'the person you were alerted about';
    const body = `✅ Update from Swift: the emergency alert involving ${who} has been closed by our safety team. If you're still concerned, please reach out to them directly.`;
    const notice: Array<{ id: string; ok: boolean }> = [];
    for (const c of contacts) {
      try { await sms.sendSms(c.phoneE164, body); notice.push({ id: c.id, ok: true }); }
      catch { notice.push({ id: c.id, ok: false }); }
    }
    const existing = (alert.deliveryReceipts as Record<string, unknown> | null) ?? {};
    await this.prisma.sosAlert.update({ where: { id }, data: { deliveryReceipts: { ...existing, resolvedNotice: notice } as never } }).catch(() => {});
  }

  /** Grace-expiry sweep — every held TRIGGER_PENDING whose grace has elapsed
   *  becomes ACTIVE. DB-owned so a closed app can't stop the escalation. */
  async promoteExpiredGrace(now = new Date()): Promise<string[]> {
    const due = await this.prisma.sosAlert.findMany({
      where: { status: 'TRIGGER_PENDING', graceEndsAt: { lte: now } },
      select: { id: true },
      take: 200,
    });
    const promoted: string[] = [];
    for (const { id } of due) {
      const moved = await this.prisma.sosAlert.updateMany({ where: { id, status: 'TRIGGER_PENDING' }, data: { status: 'ACTIVE', graceEndsAt: null } });
      if (moved.count === 1) {
        await this.fanOut(id);
        promoted.push(id);
      }
    }
    return promoted;
  }
}
