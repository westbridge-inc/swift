import type { PrismaClient, SosStatus, SosTriggerSource, SosResolutionCode, OrderType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { warRoomsFor } from './war-room';
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

/** The states in which an alert is still someone's live emergency. A POSITIVE
 *  list, so a status added to the enum later is NOT silently treated as live. */
const LIVE_STATUSES: SosStatus[] = ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'];

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

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

  /** Raise an alert. Idempotent on (actor, clientIdempotencyKey) so a retried
   *  offline trigger yields exactly one alert. Ops-raised alerts skip the grace
   *  window (a human already decided); user triggers open a short
   *  slide-to-cancel grace.
   *
   *  [F-026-17] The replay lookup is scoped to the ACTOR. When the key alone
   *  decided, a second caller reusing it was handed the first caller's alert
   *  and never raised their own — and claiming a key FIRST suppressed its
   *  rightful owner's later escalation. A key can only ever collapse a
   *  person's trigger into their own earlier one.
   */
  async create(input: SosCreateInput) {
    const key = input.clientIdempotencyKey ?? null;
    const replayWhere = key
      ? { actorUserId_clientIdempotencyKey: { actorUserId: input.actorUserId, clientIdempotencyKey: key } }
      : null;
    if (replayWhere) {
      const existing = await this.prisma.sosAlert.findUnique({ where: replayWhere });
      if (existing) return existing; // replay → the original alert, never a second
    }
    const source = input.triggerSource ?? 'BUTTON';
    const opsRaised = source === 'OPS_MANUAL';
    const now = new Date();
    const skipGrace = opsRaised || input.immediate === true || GRACE_SECONDS === 0;
    const grace = skipGrace ? null : new Date(now.getTime() + GRACE_SECONDS * 1000);

    // [F-027-17] Repeat triggers COLLAPSE onto the caller's live alert.
    //
    // The life-safety routes are exempt from the rate limiter — a throttle
    // must never stand between a person and help — which left the alert mint
    // itself unbounded: one account could raise an unlimited series of
    // distinct alerts and bury the ops war room, losing real emergencies in
    // the noise. That is the same life-safety failure from the other end.
    //
    // So the bound is on ALERTS, not requests. Someone tapping twenty times
    // raises one incident whose urgency is visibly rising, which is strictly
    // more information for ops than twenty rows — and they are never refused.
    //
    // Deliberately best-effort rather than a partial unique index: a database
    // constraint that can REFUSE an insert is the limiter's hazard in a new
    // coat. Under a true burst a handful may still slip through the read, and
    // a handful is the point — it is bounded, not zero.
    const live = await this.prisma.sosAlert.findFirst({
      where: {
        actorUserId: input.actorUserId,
        orderId: input.orderId ?? null,
        status: { in: LIVE_STATUSES },
      },
      orderBy: { triggeredAt: 'desc' },
    });
    if (live) {
      // [F-028-03] Carry the NEW FACTS forward. The first version of this
      // recorded only a count and a timestamp — so a person who pressed again
      // from a different place had their new position, source, accuracy and
      // address DISCARDED, and ops kept looking at where they were when they
      // first pressed. On a life-safety path that is the difference between
      // finding someone and not finding them. Collapsing to one incident is
      // what stops a burst burying the war room; it must cost nothing in
      // information.
      const priorRetriggers = Array.isArray(live.retriggers) ? live.retriggers : [];
      const thisRetrigger = {
        at: now.toISOString(),
        source,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        accuracyM: input.accuracyM ?? null,
        addressText: input.addressText ?? null,
        counterpartyUserId: input.counterpartyUserId ?? null,
        actorRole: input.actorRole,
        clientCreatedAt: input.clientCreatedAt?.toISOString() ?? null,
      };
      const movedTo = input.lat != null && input.lng != null;

      // [F-028-03] STATUS-SAFE. The old code did findFirst then an
      // unconditional update({id}), so a resolve landing in between meant it
      // incremented a now-RESOLVED row and handed the caller a closed alert as
      // though their emergency had been received. updateMany with the status
      // guard makes losing that race observable, and a loser FALLS THROUGH to
      // mint a real alert rather than silently attaching to a corpse.
      const merged = await this.prisma.sosAlert.updateMany({
        where: { id: live.id, status: { in: LIVE_STATUSES } },
        data: {
          retriggerCount: { increment: 1 },
          lastRetriggerAt: now,
          retriggers: [...priorRetriggers, thisRetrigger] as never,
          // The latest position IS the operative one.
          ...(movedTo ? { triggerLat: input.lat ?? null, triggerLng: input.lng ?? null, triggerAccuracyM: input.accuracyM ?? null } : {}),
          ...(input.addressText ? { triggerAddressText: input.addressText } : {}),
          // A stronger provenance sticks; a weaker one never downgrades the record.
          ...(source !== 'BUTTON' && live.triggerSource === 'BUTTON' ? { triggerSource: source } : {}),
          // A collapsed request that carried a NEW key must store it, or a lost
          // response plus a later retry mints a SECOND incident once this one
          // closes. Only fills an empty slot — never overwrites the original.
          ...(key && !live.clientIdempotencyKey ? { clientIdempotencyKey: key } : {}),
        },
      });

      if (merged.count === 1) {
        try {
          this.io.to(warRoomsFor(live.tenantId)).emit('sos:retrigger', {
            sosAlertId: live.id, actorUserId: live.actorUserId, orderId: live.orderId,
            at: now, source, lat: input.lat ?? null, lng: input.lng ?? null,
            retriggerCount: live.retriggerCount + 1,
          });
        } catch { /* the war-room nudge is best-effort; the row is the record */ }

        // The STRONGER trigger wins — and "wins" has to mean something on an
        // alert that is ALREADY active, not only on a pending one. Previously
        // an immediate guardian escalation or panic press onto an ACTIVE or
        // ACKNOWLEDGED alert did nothing at all: no confirm, no fan-out, so
        // nobody was re-paged with the new position.
        if (skipGrace && live.status === 'TRIGGER_PENDING') return this.confirm(live.id);
        if (skipGrace || movedTo) await this.fanOut(live.id);
        return this.prisma.sosAlert.findUniqueOrThrow({ where: { id: live.id } });
      }
      // Lost the race to a terminal transition — fall through and mint.
      log().warn({ sosAlertId: live.id, actorUserId: input.actorUserId }, '[F-028-03] the live alert closed mid-collapse; raising a NEW alert rather than attaching to a closed one');
    }

    // [F-027-18] Resolve the tenant from the PERSON IN DANGER, explicitly.
    //
    // Nothing set tenantId here, so it came from whichever of two accidents
    // applied: the request-scoped Prisma extension stamped it on an HTTP-raised
    // alert, and NOTHING stamped it when one was raised from a background
    // sweep — the guardian check-in-timeout ladder, the grace-expiry backstop —
    // because those carry no request context. Those alerts silently took the
    // schema default, `swift-default`, and since F-026-15 the ops page follows
    // alert.tenantId, so a tenant-B customer's auto-escalated alert paged
    // swift-default's admins and NOBODY IN TENANT B WAS EVER TOLD.
    const tenantId = (await tenantOfUser(this.prisma, input.actorUserId))
      ?? (input.orderId
        ? (await this.prisma.order.findUnique({ where: { id: input.orderId }, select: { tenantId: true } }))?.tenantId ?? null
        : null);
    if (!tenantId) {
      log().error({ actorUserId: input.actorUserId, orderId: input.orderId }, '[F-027-18] could not resolve a tenant for an SOS actor — falling back to the platform tenant');
    }

    let alert;
    try {
      alert = await this.prisma.sosAlert.create({
        data: {
          ...(tenantId ? { tenantId } : {}),
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
          clientIdempotencyKey: key,
        },
      });
    } catch (err) {
      // [F-026-17] read-then-create is not atomic: two genuine retries from the
      // same device can both miss the read. The loser must return the WINNER,
      // not a 500 to someone who is mid-emergency — and must not fan out again.
      if (replayWhere && isUniqueViolation(err)) {
        const winner = await this.prisma.sosAlert.findUnique({ where: replayWhere });
        if (winner) return winner;
      }
      throw err;
    }
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
    // [F-026-12] The window closes on the CLOCK, not on the sweep's cadence.
    // Status alone was not enough: promoteExpiredGrace is what flips
    // TRIGGER_PENDING → ACTIVE, so between graceEndsAt passing and the next
    // sweep tick an alert that should already be escalating was still
    // cancellable. Requiring graceEndsAt in the future makes the deadline
    // authoritative the instant it passes, whatever the sweep is doing.
    const moved = await this.prisma.sosAlert.updateMany({
      where: { id, status: 'TRIGGER_PENDING', graceEndsAt: { gt: new Date() } },
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
      // [F-026-15] scope the page to the alert's own tenant — see fanOut.
      tenantId: alert.tenantId,
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
      // [F-026-15] The grace-expiry backstop runs in a BACKGROUND WORKER,
      // which carries no request tenant context — and notifyAdmins without a
      // tenantId deliberately falls back to paging every active admin. So an
      // alert in one tenant paged every tenant's admins with its role, order
      // id and COORDINATES. Same class as REPORT-014 F-014-03, which the
      // dispatch ops-page already fixed by passing the row's own tenantId.
      const n = await notifyAdmins(this.prisma, this.notifications, {
        tenantId: alert.tenantId,
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
      // [F-027-16] `socket: true` recorded that we CALLED emit, not that
      // anyone received it — and emitting into an empty room never throws, so
      // the receipt read "delivered" for a room that, until this batch, had
      // seven producers and no subscriber anywhere in the codebase. Count the
      // sockets actually in the room: a silence receipt has to be able to say
      // zero. fetchSockets() is adapter-aware, so this is the cluster-wide
      // count, not just this node's.
      const rooms = warRoomsFor(alert.tenantId);
      this.io.to(rooms).emit('sos:active', { sosAlertId: id, tenantId: alert.tenantId, actorRole: alert.actorRole, orderId: alert.orderId, lat: alert.triggerLat, lng: alert.triggerLng, triggeredAt: alert.triggeredAt });
      const listeners = await this.io.in(rooms).fetchSockets();
      receipts['socketListeners'] = listeners.length;
      if (listeners.length === 0) {
        log().error({ sosAlertId: id, tenantId: alert.tenantId, rooms }, 'SOS fan-out: war-room emit reached ZERO sockets — nobody is watching the live feed');
      }
    } catch (e) {
      receipts['socketListeners'] = 0;
      log().error({ err: e, sosAlertId: id }, 'SOS fan-out: war-room emit failed');
    }

    // Guardian §5.3 L4: an alert born from an UNANSWERED check-in timeout is
    // the server guessing, not a human asking. Contacts are NOT auto-SMSed by
    // default — a false-positive "emergency" text to someone's mother erodes
    // the whole feature; ops decides within their SLA. Per-tenant override:
    // GUARDIAN_AUTONOTIFY_CONTACTS=1. Explicit human triggers (BUTTON, the
    // check-in "I need help" → GUARDIAN_ESCALATION) always fan out.
    //
    // AUDIT-FIX (F1, 2026-08-01): this gate skips ONLY the contact SMS — NOT
    // the whole fan-out. The prior `return` here also skipped the evidence
    // bundle open below, so the single highest-stakes alert (a suspected
    // abduction the server auto-escalated) captured no evidence and no live
    // location trail — exactly when tracking the victim matters most. The
    // bundle open + receipts write now always run for every ACTIVE alert.
    const skipContactSms = alert.triggerSource === 'CHECKIN_TIMEOUT' && process.env['GUARDIAN_AUTONOTIFY_CONTACTS'] !== '1';

    // Verified emergency contacts (§5), in priority order. Best-effort PER
    // contact — one failed send must not stop the rest. NEVER rate-limited or
    // budgeted: this is the real emergency, not the verification handshake.
    // Unverified numbers are skipped (they never proved reachable / aware).
    if (skipContactSms) {
      receipts['contacts'] = 'skipped:guardian-default';
    } else try {
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
    // AUDIT-FIX (F6, 2026-08-01): don't send an all-clear to contacts who were
    // never alarmed. When the initial fan-out skipped contact SMS (the
    // Guardian-timeout default), a "closed by our safety team" text lands cold
    // — confusing, and it confirms the person was involved in SOME safety
    // event. The original receipts already record whether contacts were texted.
    if ((alert.deliveryReceipts as Record<string, unknown> | null)?.['contacts'] === 'skipped:guardian-default') return;
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
