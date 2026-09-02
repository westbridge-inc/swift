import type { PrismaClient, SosStatus, SosTriggerSource, SosResolutionCode, OrderType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { warRoomsFor } from './war-room';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { stageEscalations, drainSosEscalations } from './sos-escalation';
import { appendRetrigger } from './sos-retrigger';

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

// [REPORT-036 F036-06 · S1] Math.max/Math.min do NOT repair NaN: a malformed
// SOS_CANCEL_GRACE_SECONDS made graceEndsAt an Invalid Date, which Prisma
// rejects — a 5xx on NORMAL SOS creation from one bad env var. An explicit
// finite check (not `|| default`, which would eat the VALID 0 = skip-grace
// value) selects the default for any unparseable input. Exported pure so the
// matrix is testable without module-reset games.
export function parseGraceSeconds(raw: string | undefined): number {
  const n = Number(raw ?? 3);
  return Math.min(5, Math.max(0, Number.isFinite(n) ? n : 3));
}
const GRACE_SECONDS = parseGraceSeconds(process.env['SOS_CANCEL_GRACE_SECONDS']);

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
  /** [B3] The service-job context — mutually exclusive with orderId (the
   *  route enforces it). Same loose-reference semantics as orderId. */
  serviceJobId?: string | null;
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
  /** Test seam: runs right after an ACTIVE commit and BEFORE the inline
   *  delivery — a throw here is the process dying between the two. Never set
   *  in routes. */
  observer: { afterActive?: (sosAlertId: string) => Promise<void>; afterReadLive?: (sosAlertId: string) => Promise<void> } = {};
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
    let key = input.clientIdempotencyKey ?? null;
    if (key) {
      // [TA-S1-006] Bound by the ACTOR, so it runs outside the request's tenant
      // binding: an alert lives in the INCIDENT's tenant (below), which under
      // drift is not the caller's — a replay that could not see it would mint
      // a second alert for the same emergency.
      const claimedKey: string = key;
      const existing = await runWithoutTenant(() => this.prisma.sosAlert.findUnique({
        where: { actorUserId_clientIdempotencyKey: { actorUserId: input.actorUserId, clientIdempotencyKey: claimedKey } },
      }));
      if (existing) {
        // [REPORT-035 F-035-01/02 · S0] A key hit is a REPLAY only when it is
        // the same request: same context AND the alert is still live. The old
        // unconditional return meant a client that reuses keys (the shipped
        // key store memoizes one per job, forever) had a fresh emergency on
        // job B answered with job A's alert — or a NEW cry for help answered
        // with a RESOLVED receipt, activating nothing. A stale or foreign-
        // context key is DETACHED instead: the (actor, key) unique stays bound
        // to the old row, this request proceeds keyless, and the per-context
        // collapse below still merges genuine repeats of THIS emergency.
        const sameContext =
          (existing.orderId ?? null) === (input.orderId ?? null) &&
          (existing.serviceJobId ?? null) === (input.serviceJobId ?? null);
        if (sameContext && LIVE_STATUSES.includes(existing.status)) {
          return existing; // true replay → the original alert, never a second
        }
        log().warn(
          { actorUserId: input.actorUserId, existingAlertId: existing.id, existingStatus: existing.status, sameContext },
          '[F-035-01] SOS idempotency key points at a closed or different-context alert — detaching the key and raising a NEW alert; help is never suppressed behind a stale receipt',
        );
        key = null;
      }
    }
    const replayWhere = key
      ? { actorUserId_clientIdempotencyKey: { actorUserId: input.actorUserId, clientIdempotencyKey: key } }
      : null;
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
    // [TA-S1-006] Actor-bound, and read outside the request's tenant binding
    // for the same reason as the replay above: the live alert sits in the
    // incident's tenant, and the collapse must still find it under drift.
    const live = await runWithoutTenant(() => this.prisma.sosAlert.findFirst({
      where: {
        actorUserId: input.actorUserId,
        orderId: input.orderId ?? null,
        // [B3] Collapse is PER CONTEXT: repeats on the same service job merge,
        // while a genuinely different emergency (another job, or an order)
        // still mints its own alert.
        serviceJobId: input.serviceJobId ?? null,
        status: { in: LIVE_STATUSES },
      },
      orderBy: { triggeredAt: 'desc' },
    }));
    if (live) {
      // [F-028-03] Carry the NEW FACTS forward. The first version of this
      // recorded only a count and a timestamp — so a person who pressed again
      // from a different place had their new position, source, accuracy and
      // address DISCARDED, and ops kept looking at where they were when they
      // first pressed. On a life-safety path that is the difference between
      // finding someone and not finding them. Collapsing to one incident is
      // what stops a burst burying the war room; it must cost nothing in
      // information.
      // [S-02] Test seam: the barrier between reading the live alert and
      // appending to it — two concurrent retriggers both stand here.
      await this.observer.afterReadLive?.(live.id);
      const fact = {
        at: now,
        source,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        accuracyM: input.accuracyM ?? null,
        addressText: input.addressText ?? null,
        counterpartyUserId: input.counterpartyUserId ?? null,
        actorRole: input.actorRole,
        clientCreatedAt: input.clientCreatedAt ?? null,
      };
      const movedTo = input.lat != null && input.lng != null;
      // A key that is not the alert's own key names THIS request: a retried
      // press appends once and re-pages once.
      const requestKey = key && key !== live.clientIdempotencyKey ? key : null;

      // [F-028-03] STATUS-SAFE. The old code did findFirst then an
      // unconditional update({id}), so a resolve landing in between meant it
      // incremented a now-RESOLVED row and handed the caller a closed alert as
      // though their emergency had been received. updateMany with the status
      // guard makes losing that race observable, and a loser FALLS THROUGH to
      // mint a real alert rather than silently attaching to a corpse.
      // [S-02] ONE transaction: the guarded increment takes the alert's row
      // lock, the fact becomes its own row numbered by that increment, and the
      // bounded JSON summary is rebuilt from the rows. Two concurrent presses
      // serialize on the lock — each lands, nothing is overwritten.
      // [TA-S1-006] The row lives in the incident's tenant; the retrigger must
      // reach it from a drifted caller too.
      const merged = await runWithoutTenant(() => this.prisma.$transaction(async (tx) => {
        if (requestKey) {
          const seen = await tx.sosRetrigger.findUnique({ where: { sosAlertId_requestKey: { sosAlertId: live.id, requestKey } }, select: { seq: true } });
          if (seen) return { count: 1, seq: seen.seq, replay: true };
        }
        const guarded = await tx.sosAlert.updateMany({
          where: { id: live.id, status: { in: LIVE_STATUSES } },
          data: {
            retriggerCount: { increment: 1 },
            lastRetriggerAt: now,
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
        if (guarded.count !== 1) return { count: 0, seq: 0, replay: false };
        const appended = await appendRetrigger(tx, live.id, live.tenantId, fact, requestKey);
        return { count: 1, seq: appended.seq, replay: false };
      }));
      // A retried request: the fact is already on file, the page already sent.
      if (merged.count === 1 && merged.replay) return runWithoutTenant(() => this.prisma.sosAlert.findUniqueOrThrow({ where: { id: live.id } }));

      if (merged.count === 1) {
        try {
          this.io.to(warRoomsFor(live.tenantId)).emit('sos:retrigger', {
            sosAlertId: live.id, actorUserId: live.actorUserId, orderId: live.orderId,
            at: now, source, lat: input.lat ?? null, lng: input.lng ?? null,
            retriggerCount: merged.seq,
          });
        } catch { /* the war-room nudge is best-effort; the row is the record */ }

        // The STRONGER trigger wins — and "wins" has to mean something on an
        // alert that is ALREADY active, not only on a pending one. Previously
        // an immediate guardian escalation or panic press onto an ACTIVE or
        // ACKNOWLEDGED alert did nothing at all: no confirm, no fan-out, so
        // nobody was re-paged with the new position.
        if (skipGrace && live.status === 'TRIGGER_PENDING') return this.confirm(live.id);
        if (skipGrace || movedTo) await this.escalate(live.id, { repage: merged.seq });
        return runWithoutTenant(() => this.prisma.sosAlert.findUniqueOrThrow({ where: { id: live.id } }));
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
    //
    // [TA-S1-006] The SUBJECT's durable tenant decides the routing — the
    // service job's own column, or the order's — and the actor's tenant only
    // for a context-free panic. Both parties are co-tenanted at creation, so
    // on a healthy row the answer is the actor's tenant anyway; on a drifted
    // or corrupt one, the incident no longer routes to two different
    // operators depending on who pressed the button. The subject is read
    // OUTSIDE the request's tenant binding: the route has already proven
    // participation by user id, and a binding that hid the row would
    // silently re-route a life-safety page to the caller's operator instead
    // of the incident's.
    const subjectTenant = await runWithoutTenant(async () => {
      if (input.serviceJobId) {
        return (await this.prisma.serviceJob.findUnique({ where: { id: input.serviceJobId }, select: { tenantId: true } }))?.tenantId ?? null;
      }
      if (input.orderId) {
        return (await this.prisma.order.findUnique({ where: { id: input.orderId }, select: { tenantId: true } }))?.tenantId ?? null;
      }
      return null;
    });
    const tenantId = subjectTenant ?? (await tenantOfUser(this.prisma, input.actorUserId));
    if (!tenantId) {
      // [F-028-04] This used to say "falling back to the platform tenant" while
      // the insert OMITTED the column — so the row took the schema default and
      // came out belonging to `swift-default`, a real tenant with real admins.
      // fanOut then paged THOSE admins with this person's order and location,
      // and the tenant whose customer was actually in danger heard nothing. The
      // log was describing an intent the code did not carry out.
      log().error(
        { actorUserId: input.actorUserId, orderId: input.orderId },
        '[F-028-04] could not resolve a tenant for an SOS actor — this alert is written with a NULL tenant and reaches PLATFORM OPERATORS ONLY, never a tenant admin',
      );
    }

    let alert;
    try {
      alert = await runWithoutTenant(() => this.prisma.$transaction(async (tx) => tx.sosAlert.create({
        data: {
          // ALWAYS written, never omitted [F-028-04]. Omitting it let the
          // `swift-default` column default decide the routing of a life-safety
          // row. An explicit null overrides that default and says "unknown",
          // which every consumer already reads correctly: warRoomsFor(null) is
          // the platform war room alone, notifyAdmins(null) is SUPER_ADMIN
          // only, and the RLS predicate is never true for NULL. [TA-S1-006]
          // The insert runs OUTSIDE the request's tenant binding, so the
          // tenant resolved above — the INCIDENT's — is what lands; the
          // extension would otherwise stamp the caller's tenant over it.
          tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          orderId: input.orderId ?? null,
          orderType: input.orderType ?? null,
          serviceJobId: input.serviceJobId ?? null,
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
      }).then(async (created) => {
        // [S-01] ACTIVE-at-birth (ops-raised / immediate / no grace): the
        // delivery policy is staged in the SAME transaction as the row.
        if (!grace) await stageEscalations(tx, created);
        return created;
      })));
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
    if (!grace) await this.escalate(alert.id); // already ACTIVE (ops-raised / immediate / no-grace tenant)
    return alert;
  }

  /** TRIGGER_PENDING → ACTIVE. Called by the owner ("I need help now") and by
   *  the grace-expiry sweep. CAS so a race between the two fires the fan-out once. */
  async confirm(id: string) {
    const moved = await this.activate(id);
    if (moved) await this.escalate(id);
    return this.prisma.sosAlert.findUniqueOrThrow({ where: { id } });
  }

  /** [S-01] TRIGGER_PENDING → ACTIVE and the delivery policy, ONE transaction:
   *  a process that dies right after this commit leaves rows a worker
   *  delivers, never an ACTIVE alert nobody was told about. CAS: a race
   *  between the owner and the grace sweep stages once. */
  private async activate(id: string): Promise<boolean> {
    return runWithoutTenant(() => this.prisma.$transaction(async (tx) => {
      const moved = await tx.sosAlert.updateMany({ where: { id, status: 'TRIGGER_PENDING' }, data: { status: 'ACTIVE', graceEndsAt: null } });
      if (moved.count !== 1) return false;
      const row = await tx.sosAlert.findUniqueOrThrow({ where: { id }, select: { id: true, tenantId: true, actorUserId: true, triggerSource: true } });
      await stageEscalations(tx, row);
      return true;
    }));
  }

  /** [S-01] Deliver what the alert owns — inline, right now (the fail-safe
   *  path); anything that fails or is left over is the worker's. A re-page
   *  (a retrigger with a new position) stages fresh page rows first. */
  private async escalate(id: string, opts: { repage?: number } = {}): Promise<void> {
    await this.observer.afterActive?.(id);
    await runWithoutTenant(async () => {
      if (opts.repage) {
        const row = await this.prisma.sosAlert.findUnique({ where: { id }, select: { id: true, tenantId: true, actorUserId: true, triggerSource: true, status: true } });
        if (!row || (row.status !== 'ACTIVE' && row.status !== 'ACKNOWLEDGED')) return;
        await this.prisma.$transaction(async (tx) => {
          // An alert that reached ACTIVE without rows (pre-outbox history, or
          // an ops-side status edit) gains its base policy here — idempotent.
          await stageEscalations(tx, row);
          await stageEscalations(tx, row, { repage: opts.repage });
        });
      }
      await drainSosEscalations(this.prisma, this.io, { alertIds: [id] });
    });
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
          source: { type: 'SOS_RESOLUTION', id: resolved.id },
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
      // [S-01] The CAS and the policy are one transaction; delivery follows.
      const moved = await this.activate(id);
      if (moved) {
        await this.escalate(id);
        promoted.push(id);
      }
    }
    return promoted;
  }
}
