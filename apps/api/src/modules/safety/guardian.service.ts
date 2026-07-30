import type { PrismaClient, TripSafetySession, GuardianCloseReason } from '@prisma/client';
import type { Server } from 'socket.io';
import { haversineDistance } from '../../utils/distance';
import { log } from '../../utils/logger';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { SosService } from './sos.service';

// Trip Guardian (safety spec §5) — server-side monitoring of live taxi rides.
// Same runtime doctrine as the SOS grace sweep: a scheduled tick that owns ALL
// session state in the DB, so a killed app, a restarted worker, or overlapping
// ticks can never lose a rung of the ladder.
//
// One source of truth for location (spec §2): the sweep reads the SAME
// persisted driver fix that dispatch reads (Driver.currentLat/currentLng,
// written by PUT /driver/location's throttled branch). No second stream, no
// listener on the hot ping path — a Guardian bug can never slow a location
// ping or a dispatch query.
//
// The graduated ladder (§5.3) — never jump straight to alarm:
//   L1 detector flag (silent log + war-room advisory)
//   L2 soft check-in  → passenger push/card ("Everything OK?"); no response is
//                       NOT an emergency yet (phones sit in pockets)
//   L3 hard check-in  → status CHECKIN_PENDING, server-owned deadline, plus a
//                       low-key driver-side "confirm trip status" prompt
//   L4 auto-SOS       → deadline passed, neither party responsive → SosAlert
//                       (CHECKIN_TIMEOUT, no grace); emergency contacts are
//                       NOT auto-SMSed at this rung by default — ops decides
//                       (GUARDIAN_AUTONOTIFY_CONTACTS flips it per-tenant)
// Every rung is a DB column + CAS transition; push bodies stay minimal (§15:
// "Safety check-in", never anything scarier over an insecure channel).
//
// Deviation geometry: the stack's MapsProvider has no route polylines, so the
// spec's perpendicular-distance detector is adapted to what its own rule
// actually demands — "only a deviation that DIVERGES from destination or a
// stop counts" (§5.2). We ratchet the minimum distance-to-destination seen so
// far; sustained travel AWAY from that ratchet beyond the band threshold is a
// divergence. A legit reroute that still converges keeps shrinking the
// ratchet and never flags; one-way loops are absorbed by the sustain window.

// ─── Tunables (env-overridable, spec §5 defaults; read lazily so tests can
//     vary them per case). Band order everywhere: [LOW, ELEVATED, HIGH]. ────

type Band = 0 | 1 | 2; // LOW | ELEVATED | HIGH

const num = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const csv3 = (name: string, def: [number, number, number]): [number, number, number] => {
  const parts = (process.env[name] ?? '').split(',').map((p) => Number(p.trim()));
  if (parts.length === 3 && parts.every((p) => Number.isFinite(p) && p > 0)) return parts as [number, number, number];
  return def;
};

const deviationMeters = () => csv3('GUARDIAN_DEVIATION_M', [500, 350, 250]);
const stopMinutes = () => csv3('GUARDIAN_STOP_MINUTES', [5, 4, 3]);
const sustainSeconds = () => num('GUARDIAN_DEVIATION_SUSTAIN_SECONDS', 90);
const stopRadiusM = () => num('GUARDIAN_STOP_RADIUS_M', 60);
const nearEndpointM = () => num('GUARDIAN_NEAR_ENDPOINT_M', 150);
const overdueMinMinutes = () => num('GUARDIAN_OVERDUE_MIN_MINUTES', 15);
const staleGpsMinutes = () => num('GUARDIAN_STALE_GPS_MINUTES', 3);
/** §5.4 — how far from the destination a "completed" trip may end before it
 *  is flagged for post-trip review. Generous: addresses are imprecise and the
 *  driver may roll on before the closing tick consumes a fix. */
const completionToleranceM = () => num('GUARDIAN_COMPLETION_TOLERANCE_M', 750);
/** §5.3 — how long a soft check-in may sit unanswered before the hard one. */
const softWaitSeconds = () => num('GUARDIAN_SOFT_WAIT_SECONDS', 180);
/** §5.3 CHECKIN_DEADLINE_SECONDS — the hard check-in countdown. */
const checkinDeadlineSeconds = () => num('GUARDIAN_CHECKIN_DEADLINE_SECONDS', 120);
/** After an all-good response, how long before the ladder may re-prompt. */
const checkinCooldownSeconds = () => num('GUARDIAN_CHECKIN_COOLDOWN_SECONDS', 600);
/** Tenant-local clock offset for the NIGHT factor; Guyana is UTC-4 all year. */
const tzOffsetMinutes = (): number => {
  const v = Number(process.env['GUARDIAN_TZ_OFFSET_MINUTES']);
  return Number.isFinite(v) ? v : -240;
};

export const riskBand = (score: number): Band => (score >= 60 ? 2 : score >= 30 ? 1 : 0);
export const BAND_NAMES = ['LOW', 'ELEVATED', 'HIGH'] as const;

// §5.1 additive risk weights (spec defaults).
const WEIGHT = { NIGHT: 20, NEW_DRIVER: 15, PRIOR_SOS_ON_DRIVER: 30, ENHANCED_OPT_IN: 20 } as const;
// Not yet computable on this stack (documented, not silently dropped):
// cash-above-ID-threshold (taxi is flat cash-only in V1), low-confidence
// address zones and caution zones (no zone data exists yet).

/** Rolling detector scratch — lives in TripSafetySession.deviationState.
 *  Only the sweep and the response endpoints touch it; decisions land in
 *  typed columns. */
interface DetectorState {
  minDistToDestM?: number;
  divergingSinceMs?: number | null;
  stopAnchor?: { lat: number; lng: number } | null;
  stopSinceMs?: number | null;
  flags?: { deviation?: string; longStop?: string; overdue?: string; staleGps?: string };
  /** Set when the passenger answered "all good" — suppresses re-prompts for
   *  the cooldown window. */
  lastCheckinClearedAtMs?: number;
  /** Driver's "trip status OK" tap (§5.3 L3) — a responsive driver blocks the
   *  auto-SOS at the deadline (flat-tire case); cleared on de-escalation. */
  driverConfirmedAtMs?: number;
  /** Last fix the session CONSUMED while live — §5.4 completion sanity reads
   *  this, not the driver row (the driver may roll on after completing). */
  lastFix?: { lat: number; lng: number; atMs: number };
  /** §5.4 — completion happened far from the destination; set once at close. */
  completionFlag?: { distM: number; at: string };
  events?: Array<{ t: string; kind: string; detail?: Record<string, unknown> }>;
}

const metersBetween = (aLat: number, aLng: number, bLat: number, bLng: number) =>
  haversineDistance(aLat, aLng, bLat, bLng) * 1000;

const pushEvent = (state: DetectorState, now: Date, kind: string, detail?: Record<string, unknown>) => {
  state.events = [...(state.events ?? []), { t: now.toISOString(), kind, ...(detail ? { detail } : {}) }].slice(-40);
};

/** The position-anomaly latches that arm the ladder. staleGps deliberately
 *  does NOT arm it (you can't fix a dead phone by pushing to it; the
 *  stale-mover watchdog separately pages ops when a holder freezes). */
const anomalous = (state: DetectorState): boolean =>
  Boolean(state.flags?.deviation || state.flags?.longStop || state.flags?.overdue);

/** Order statuses a Guardian session monitors. The moment an order leaves
 *  this set the session closes (reconciled by the sweep — no lifecycle hooks
 *  in the ride routes, so no shared-code writes). */
const MONITORED_ORDER_STATUS = 'RIDE_IN_PROGRESS';
const OPEN_SESSION_STATUSES = ['MONITORING', 'CHECKIN_PENDING', 'ESCALATING'] as const;

type OrderSnapshot = {
  id: string;
  status: string;
  pickedUpAt: Date | null;
  taxiDuration: number | null;
  pickupLat: unknown;
  pickupLng: unknown;
  deliveryLat: unknown;
  deliveryLng: unknown;
  driver: { currentLat: number | null; currentLng: number | null; lastLocationUpdate: Date | null } | null;
};

export interface GuardianSweepResult {
  opened: number;
  closed: number;
  flagged: number;
  escalated: number;
}

export class GuardianService {
  private notifications: NotificationService;
  private sos: SosService;

  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
    this.sos = new SosService(prisma, io);
  }

  /** One tick: open sessions for newly-in-progress rides, run detectors and
   *  the ladder on live ones, close sessions whose ride ended. Idempotent and
   *  safe to overlap — every mutation is create-unique or compare-and-set. */
  async sweep(now = new Date()): Promise<GuardianSweepResult> {
    const opened = await this.openNewSessions(now);
    const rest = await this.reconcileOpenSessions(now);
    return { opened, ...rest };
  }

  // ── Open: RIDE_IN_PROGRESS taxi rides without a session ─────────────────

  private async openNewSessions(now: Date): Promise<number> {
    const live = await this.prisma.order.findMany({
      where: { orderType: 'TAXI', status: MONITORED_ORDER_STATUS, driverId: { not: null } },
      select: {
        id: true,
        customerId: true,
        pickedUpAt: true,
        taxiDuration: true,
        driver: { select: { userId: true, createdAt: true, totalRides: true } },
      },
      take: 200,
    });
    if (live.length === 0) return 0;

    const existing = await this.prisma.tripSafetySession.findMany({
      where: { orderId: { in: live.map((o) => o.id) } },
      select: { orderId: true },
    });
    const known = new Set(existing.map((s) => s.orderId));

    let opened = 0;
    for (const order of live) {
      if (known.has(order.id) || !order.driver) continue;
      const { score, factors } = await this.scoreRisk(order, now);
      const plannedEtaAt =
        order.pickedUpAt && order.taxiDuration
          ? new Date(order.pickedUpAt.getTime() + order.taxiDuration * 60_000)
          : null;
      try {
        const session = await this.prisma.tripSafetySession.create({
          data: {
            orderId: order.id,
            orderType: 'TAXI',
            passengerUserId: order.customerId,
            driverUserId: order.driver.userId,
            riskScore: score,
            riskFactors: factors,
            plannedEtaAt,
            deviationState: { events: [{ t: now.toISOString(), kind: 'SESSION_OPENED', detail: { score, factors } }] },
          },
        });
        opened += 1;
        // HIGH-band trips are proactively visible to ops (§5.1) — advisory
        // only, never auto-deciding.
        if (riskBand(score) === 2) {
          this.warRoom('guardian:high-risk', {
            sessionId: session.id,
            orderId: order.id,
            riskScore: score,
            riskFactors: factors,
            openedAt: now.toISOString(),
          });
        }
      } catch {
        // unique(orderId) violation = a racing tick opened it first — exactly
        // the invariant the constraint exists to hold. Nothing to do.
      }
    }
    return opened;
  }

  /** §5.1 additive score. Factors snapshot into riskFactors so ops can always
   *  see WHY a trip scored what it did. */
  private async scoreRisk(
    order: { customerId: string; pickedUpAt: Date | null; driver: { userId: string; createdAt: Date; totalRides: number } | null },
    now: Date,
  ): Promise<{ score: number; factors: string[] }> {
    const factors: string[] = [];
    let score = 0;

    // Night trip 21:00–05:00 tenant-local.
    const at = order.pickedUpAt ?? now;
    const localHour = new Date(at.getTime() + tzOffsetMinutes() * 60_000).getUTCHours();
    if (localHour >= 21 || localHour < 5) {
      score += WEIGHT.NIGHT;
      factors.push('NIGHT');
    }

    if (order.driver) {
      const tenureDays = (now.getTime() - order.driver.createdAt.getTime()) / 86_400_000;
      if (tenureDays < 30 || order.driver.totalRides < 50) {
        score += WEIGHT.NEW_DRIVER;
        factors.push('NEW_DRIVER');
      }
      // Spec factor "prior S2+ incident on driver" — the incident module is a
      // later milestone (M6), so until it exists the strongest equivalent
      // signal on this stack is a resolved SOS where this driver was the
      // counterparty and ops coded it POLICE_INVOLVED or ABUSE.
      const priorSos = await this.prisma.sosAlert.count({
        where: {
          counterpartyUserId: order.driver.userId,
          status: 'RESOLVED',
          resolutionCode: { in: ['POLICE_INVOLVED', 'ABUSE'] },
        },
      });
      if (priorSos > 0) {
        score += WEIGHT.PRIOR_SOS_ON_DRIVER;
        factors.push('PRIOR_SOS_ON_DRIVER');
      }
    }

    // §5.1 enhanced monitoring: strictly the user's own opt-in toggle.
    const passenger = await this.prisma.user.findUnique({
      where: { id: order.customerId },
      select: { enhancedSafetyMonitoring: true },
    });
    if (passenger?.enhancedSafetyMonitoring) {
      score += WEIGHT.ENHANCED_OPT_IN;
      factors.push('ENHANCED_OPT_IN');
    }

    return { score, factors };
  }

  // ── Reconcile: detectors + ladder on live sessions, close finished ones ──

  private async reconcileOpenSessions(now: Date): Promise<{ closed: number; flagged: number; escalated: number }> {
    const sessions = await this.prisma.tripSafetySession.findMany({
      where: { status: { in: [...OPEN_SESSION_STATUSES] } },
      take: 500,
    });
    if (sessions.length === 0) return { closed: 0, flagged: 0, escalated: 0 };

    const orders = await this.prisma.order.findMany({
      where: { id: { in: sessions.map((s) => s.orderId) } },
      select: {
        id: true,
        status: true,
        pickedUpAt: true,
        taxiDuration: true,
        pickupLat: true,
        pickupLng: true,
        deliveryLat: true,
        deliveryLng: true,
        driver: { select: { currentLat: true, currentLng: true, lastLocationUpdate: true } },
      },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));

    let closed = 0;
    let flagged = 0;
    let escalated = 0;
    for (const session of sessions) {
      const order = byId.get(session.orderId) ?? null;

      // A session mid-escalation finishes its SOS hand-off BEFORE anything
      // else — even if the ride "completed" underneath it. A timed-out
      // check-in must not be silenced by whoever taps "complete ride"
      // (that could be the attacker); ops closes it, not the trip state.
      if (session.status === 'ESCALATING') {
        escalated += await this.finishEscalation(session, order, now);
        continue;
      }

      if (!order) {
        // Order hard-deleted underneath the session (test fixtures, purges) —
        // close rather than monitor a ghost forever.
        closed += await this.close(session, 'TRIP_CANCELLED', now, null);
        continue;
      }
      if (order.status !== MONITORED_ORDER_STATUS) {
        const reason: GuardianCloseReason = order.status === 'CANCELLED' ? 'TRIP_CANCELLED' : 'TRIP_COMPLETED';
        closed += await this.close(session, reason, now, order);
        continue;
      }

      const state: DetectorState = (session.deviationState as DetectorState | null) ?? {};
      state.flags = state.flags ?? {};
      const { newFlags, freshFixAt } = this.runDetectors(session, order, state, now);
      flagged += newFlags;
      escalated += await this.evaluateLadder(session, order, state, now);
      await this.prisma.tripSafetySession
        .update({
          where: { id: session.id },
          data: { deviationState: state as never, ...(freshFixAt ? { lastLocationAt: freshFixAt } : {}) },
        })
        .catch(() => {}); // scratch-state write must never fail the tick
    }
    return { closed, flagged, escalated };
  }

  private async close(session: TripSafetySession, reason: GuardianCloseReason, now: Date, order: OrderSnapshot | null): Promise<number> {
    // CAS on the open statuses so a racing tick closes exactly once.
    const moved = await this.prisma.tripSafetySession.updateMany({
      where: { id: session.id, status: { in: [...OPEN_SESSION_STATUSES] } },
      data: { status: 'CLOSED', closeReason: reason, closedAt: now },
    });
    if (moved.count === 1 && reason === 'TRIP_COMPLETED' && order) {
      await this.completionSanity(session, order, now).catch(() => {}); // advisory — never fails a close
    }
    return moved.count;
  }

  /** §5.4 — a trip "completed" far from its destination, with the anomaly
   *  latches telling the same story, is a post-trip review item. Uses the last
   *  fix the SESSION consumed (the driver row moves on after completion).
   *  Advisory only: war-room + ops page; the S3 auto-case lands with M6. */
  private async completionSanity(session: TripSafetySession, order: OrderSnapshot, now: Date) {
    const state: DetectorState = (session.deviationState as DetectorState | null) ?? {};
    if (state.completionFlag) return;
    const dest =
      order.deliveryLat != null && order.deliveryLng != null
        ? { lat: Number(order.deliveryLat), lng: Number(order.deliveryLng) }
        : null;
    if (!dest || !state.lastFix) return;
    const distM = Math.round(metersBetween(state.lastFix.lat, state.lastFix.lng, dest.lat, dest.lng));
    if (distM <= completionToleranceM()) return;

    state.completionFlag = { distM, at: now.toISOString() };
    pushEvent(state, now, 'COMPLETION_FAR_FROM_DESTINATION', { distM, toleranceM: completionToleranceM() });
    await this.prisma.tripSafetySession
      .update({ where: { id: session.id }, data: { deviationState: state as never } })
      .catch(() => {});
    log().warn({ sessionId: session.id, orderId: session.orderId, distM }, 'Trip Guardian: ride completed far from its destination');
    this.warRoom('guardian:completion-flag', { sessionId: session.id, orderId: session.orderId, distM, riskScore: session.riskScore, at: now.toISOString() });
    await notifyAdmins(this.prisma, this.notifications, {
      title: 'Trip ended far from destination',
      body: `A taxi ride completed ${distM}m from its destination. Review the trip on the war-room.`,
      data: { kind: 'guardian_completion_flag', sessionId: session.id, orderId: session.orderId, distM },
    }).catch(() => {});
  }

  // ── L1 detectors (§5.2) ──────────────────────────────────────────────────

  /** Pure state-machine step: mutates `state`, writes nothing. Each flag
   *  latches ONCE per session (the flag itself is the dedup), lands in the
   *  event log, and pings the war-room as advisory. */
  private runDetectors(
    session: TripSafetySession,
    order: OrderSnapshot,
    state: DetectorState,
    now: Date,
  ): { newFlags: number; freshFixAt: Date | null } {
    const band = riskBand(session.riskScore);
    let newFlags = 0;

    const raise = (kind: keyof NonNullable<DetectorState['flags']>, detail: Record<string, unknown>) => {
      state.flags![kind] = now.toISOString();
      pushEvent(state, now, `FLAG_${kind.replace(/([A-Z])/g, '_$1').toUpperCase()}`, detail);
      newFlags += 1;
      log().warn({ sessionId: session.id, orderId: session.orderId, kind, ...detail }, 'Trip Guardian detector flag');
      this.warRoom('guardian:flag', {
        sessionId: session.id,
        orderId: session.orderId,
        kind,
        riskScore: session.riskScore,
        band: BAND_NAMES[band],
        at: now.toISOString(),
        ...detail,
      });
    };

    const fix = order.driver;
    const dest =
      order.deliveryLat != null && order.deliveryLng != null
        ? { lat: Number(order.deliveryLat), lng: Number(order.deliveryLng) }
        : null;
    const pickup =
      order.pickupLat != null && order.pickupLng != null
        ? { lat: Number(order.pickupLat), lng: Number(order.pickupLng) }
        : null;

    // Stale telemetry — a phone that stopped reporting mid-ride. Its own L1
    // signal (the stale-mover sweep separately handles paging when it forces a
    // holder offline); the ladder never rests on a frozen fix because the
    // position detectors below only advance on fresh ones.
    const fixAt = fix?.lastLocationUpdate ?? null;
    if (fixAt && now.getTime() - fixAt.getTime() > staleGpsMinutes() * 60_000) {
      if (!state.flags!.staleGps) raise('staleGps', { lastFixAt: fixAt.toISOString() });
    } else if (state.flags!.staleGps) {
      // Telemetry recovered — clear so a later real stall is caught again.
      delete state.flags!.staleGps;
      pushEvent(state, now, 'STALE_GPS_RECOVERED');
    }

    // Position-based detectors only advance on a FRESH fix (newer than the
    // last one this session consumed) — a frozen GPS must not fake a stop.
    const isFreshFix =
      fix?.currentLat != null &&
      fix.currentLng != null &&
      fixAt != null &&
      (session.lastLocationAt == null || fixAt.getTime() > session.lastLocationAt.getTime());

    if (isFreshFix && dest) {
      const lat = fix.currentLat as number;
      const lng = fix.currentLng as number;
      state.lastFix = { lat, lng, atMs: fixAt.getTime() };
      const distToDest = metersBetween(lat, lng, dest.lat, dest.lng);

      // Divergence ratchet (§5.2, adapted — see header).
      const prevMin = state.minDistToDestM;
      state.minDistToDestM = prevMin == null ? distToDest : Math.min(prevMin, distToDest);
      const threshold = deviationMeters()[band];
      const diverging = distToDest > state.minDistToDestM + threshold;
      if (diverging) {
        state.divergingSinceMs = state.divergingSinceMs ?? fixAt.getTime();
        const sustainedMs = fixAt.getTime() - state.divergingSinceMs;
        if (sustainedMs >= sustainSeconds() * 1000 && !state.flags!.deviation) {
          raise('deviation', {
            distToDestM: Math.round(distToDest),
            minDistToDestM: Math.round(state.minDistToDestM),
            thresholdM: threshold,
            sustainedS: Math.round(sustainedMs / 1000),
          });
        }
      } else {
        state.divergingSinceMs = null; // converging again — blip absorbed
      }

      // Long-stop (§5.2): stationary beyond the band budget, measured on the
      // fix clock (frozen GPS can't advance it), suppressed near either
      // endpoint (boarding/alighting are legitimate stops).
      const nearEndpoint =
        distToDest < nearEndpointM() ||
        (pickup ? metersBetween(lat, lng, pickup.lat, pickup.lng) < nearEndpointM() : false);
      if (nearEndpoint) {
        state.stopAnchor = null;
        state.stopSinceMs = null;
      } else if (
        state.stopAnchor &&
        metersBetween(lat, lng, state.stopAnchor.lat, state.stopAnchor.lng) <= stopRadiusM()
      ) {
        const stoppedMs = fixAt.getTime() - (state.stopSinceMs ?? fixAt.getTime());
        if (stoppedMs >= stopMinutes()[band] * 60_000 && !state.flags!.longStop) {
          raise('longStop', { stoppedMinutes: Math.round(stoppedMs / 60_000), anchor: state.stopAnchor });
        }
      } else {
        state.stopAnchor = { lat, lng };
        state.stopSinceMs = fixAt.getTime();
      }
    }

    // Overdue (§5.2): now past planned ETA + max(floor, 50% of the plan).
    if (session.plannedEtaAt && !state.flags!.overdue) {
      const plannedMinutes =
        order.taxiDuration ??
        (order.pickedUpAt ? (session.plannedEtaAt.getTime() - order.pickedUpAt.getTime()) / 60_000 : 0);
      const allowanceMs = Math.max(overdueMinMinutes(), plannedMinutes * 0.5) * 60_000;
      if (now.getTime() > session.plannedEtaAt.getTime() + allowanceMs) {
        raise('overdue', {
          plannedEtaAt: session.plannedEtaAt.toISOString(),
          allowanceMinutes: Math.round(allowanceMs / 60_000),
        });
      }
    }

    return { newFlags, freshFixAt: isFreshFix && fixAt ? fixAt : null };
  }

  // ── The graduated ladder (§5.3) ──────────────────────────────────────────

  /** Walks one session up the ladder if its state says so. All transitions
   *  are CAS on the pre-read row — a racing response endpoint always wins or
   *  loses atomically, never both. Returns 1 when this tick auto-raised SOS. */
  private async evaluateLadder(session: TripSafetySession, order: OrderSnapshot, state: DetectorState, now: Date): Promise<number> {
    // L2 — soft check-in: first anomaly, nothing pending, out of cooldown.
    if (session.status === 'MONITORING' && anomalous(state) && !session.checkinRequestedAt) {
      const cleared = state.lastCheckinClearedAtMs ?? 0;
      if (now.getTime() - cleared < checkinCooldownSeconds() * 1000) return 0;
      const moved = await this.prisma.tripSafetySession.updateMany({
        where: { id: session.id, status: 'MONITORING', checkinRequestedAt: null },
        // A fresh ask wipes any answer from a PREVIOUS ladder cycle — else a
        // stale respondedAt would block L3 forever on the second climb.
        data: { checkinRequestedAt: now, checkinRespondedAt: null, checkinDeadlineAt: null },
      });
      if (moved.count === 1) {
        pushEvent(state, now, 'L2_SOFT_CHECKIN');
        if (session.passengerUserId) {
          await this.notifications.send({
            userId: session.passengerUserId,
            type: 'SAFETY',
            title: 'Safety check-in',
            body: 'Everything OK on your trip? Open Swift to respond.',
            data: { kind: 'guardian_checkin', level: 'SOFT', sessionId: session.id, orderId: session.orderId },
          });
        }
        this.roomEmit(`order:${session.orderId}`, 'guardian:checkin', {
          level: 'SOFT',
          sessionId: session.id,
          orderId: session.orderId,
          requestedAt: now.toISOString(),
        });
        this.warRoom('guardian:checkin-sent', { sessionId: session.id, orderId: session.orderId, level: 'SOFT' });
      }
      return 0;
    }

    // L3 — hard check-in: soft one unanswered past the wait, still anomalous.
    if (
      session.status === 'MONITORING' &&
      anomalous(state) &&
      session.checkinRequestedAt &&
      !session.checkinRespondedAt &&
      now.getTime() - session.checkinRequestedAt.getTime() >= softWaitSeconds() * 1000
    ) {
      const deadline = new Date(now.getTime() + checkinDeadlineSeconds() * 1000);
      const moved = await this.prisma.tripSafetySession.updateMany({
        where: { id: session.id, status: 'MONITORING', checkinRespondedAt: null },
        data: { status: 'CHECKIN_PENDING', checkinDeadlineAt: deadline },
      });
      if (moved.count === 1) {
        pushEvent(state, now, 'L3_HARD_CHECKIN', { deadline: deadline.toISOString() });
        if (session.passengerUserId) {
          await this.notifications.send({
            userId: session.passengerUserId,
            type: 'SAFETY',
            title: 'Safety check-in — please respond',
            body: 'Please confirm you are OK in the app.',
            data: { kind: 'guardian_checkin', level: 'HARD', sessionId: session.id, orderId: session.orderId, respondBy: deadline.toISOString() },
          });
        }
        // Low-key driver-side prompt (§5.3): a stopped driver with a flat
        // tire will answer — and that answer is a record.
        await this.notifications.send({
          userId: session.driverUserId,
          type: 'SAFETY',
          title: 'Trip status check',
          body: 'Please confirm your trip status in the app.',
          data: { kind: 'guardian_driver_confirm', sessionId: session.id, orderId: session.orderId },
        });
        this.roomEmit(`order:${session.orderId}`, 'guardian:checkin', {
          level: 'HARD',
          sessionId: session.id,
          orderId: session.orderId,
          requestedAt: session.checkinRequestedAt.toISOString(),
          respondBy: deadline.toISOString(),
        });
        this.warRoom('guardian:checkin-sent', { sessionId: session.id, orderId: session.orderId, level: 'HARD', respondBy: deadline.toISOString() });
      }
      return 0;
    }

    // L4 — deadline passed with no passenger response.
    if (
      session.status === 'CHECKIN_PENDING' &&
      session.checkinDeadlineAt &&
      now.getTime() >= session.checkinDeadlineAt.getTime() &&
      !session.checkinRespondedAt
    ) {
      // A responsive DRIVER blocks the auto-SOS (§5.3: "neither party
      // responsive") — the flat-tire case. De-escalate, reset the detectors,
      // and leave the whole exchange on the record; if the anomaly persists
      // the ladder simply climbs again and ops sees every cycle. Existence is
      // enough: resetAfterAllClear wipes the confirm on every de-escalation,
      // so a confirm can never absolve a LATER cycle it wasn't part of.
      if (state.driverConfirmedAtMs) {
        const moved = await this.prisma.tripSafetySession.updateMany({
          where: { id: session.id, status: 'CHECKIN_PENDING' },
          data: { status: 'MONITORING', checkinRequestedAt: null, checkinDeadlineAt: null },
        });
        if (moved.count === 1) {
          this.resetAfterAllClear(state, now, 'DRIVER_CONFIRMED_DEESCALATE');
          this.warRoom('guardian:driver-confirmed', { sessionId: session.id, orderId: session.orderId });
        }
        return 0;
      }

      const moved = await this.prisma.tripSafetySession.updateMany({
        where: { id: session.id, status: 'CHECKIN_PENDING' },
        data: { status: 'ESCALATING' },
      });
      if (moved.count === 1) {
        pushEvent(state, now, 'L4_ESCALATE');
        return this.finishEscalation({ ...session, status: 'ESCALATING' }, order, now);
      }
      return 0;
    }

    return 0;
  }

  /** ESCALATING → SOS → CLOSED/ESCALATED. Separated so a tick that died
   *  between the CAS and the SOS create retries here forever until it lands.
   *  clientIdempotencyKey pins ONE alert per session no matter how many
   *  retries or racing ticks. */
  private async finishEscalation(session: TripSafetySession, order: OrderSnapshot | null, now: Date): Promise<number> {
    let sosId: string;
    try {
      const alert = await this.sos.create({
        actorUserId: session.passengerUserId ?? session.driverUserId,
        actorRole: 'CUSTOMER',
        orderId: session.orderId,
        orderType: session.orderType,
        counterpartyUserId: session.driverUserId,
        triggerSource: 'CHECKIN_TIMEOUT',
        immediate: true, // server-decided emergency — a grace bar helps no one
        lat: order?.driver?.currentLat ?? null,
        lng: order?.driver?.currentLng ?? null,
        clientIdempotencyKey: `guardian:${session.id}`,
      });
      sosId = alert.id;
    } catch (e) {
      log().error({ err: e, sessionId: session.id }, 'Guardian auto-SOS failed — session stays ESCALATING for retry');
      return 0;
    }
    await this.prisma.tripSafetySession.updateMany({
      where: { id: session.id, status: 'ESCALATING' },
      data: { status: 'CLOSED', closeReason: 'ESCALATED', escalatedToSosId: sosId, closedAt: now },
    });
    log().warn({ sessionId: session.id, orderId: session.orderId, sosId }, 'Trip Guardian escalated an unanswered check-in to SOS');
    return 1;
  }

  // ── Check-in responses (§5.3) — called from the safety routes ────────────

  /** Passenger answers the check-in card. OK de-escalates and re-arms the
   *  detectors; NEED_HELP is an explicit distress signal and raises a full
   *  SOS immediately (contacts included — this is a human asking, not a
   *  timeout guessing). */
  async respondToCheckin(passengerUserId: string, response: 'OK' | 'NEED_HELP') {
    const session = await this.prisma.tripSafetySession.findFirst({
      where: { passengerUserId, status: { in: ['MONITORING', 'CHECKIN_PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) throw new NotFoundError('SafetyCheckin', passengerUserId);

    if (response === 'NEED_HELP') {
      const alert = await this.sos.create({
        actorUserId: passengerUserId,
        actorRole: 'CUSTOMER',
        orderId: session.orderId,
        orderType: session.orderType,
        counterpartyUserId: session.driverUserId,
        triggerSource: 'GUARDIAN_ESCALATION',
        immediate: true,
        clientIdempotencyKey: `guardian-help:${session.id}`,
      });
      await this.prisma.tripSafetySession.updateMany({
        where: { id: session.id, status: { in: ['MONITORING', 'CHECKIN_PENDING'] } },
        data: { status: 'CLOSED', closeReason: 'ESCALATED', escalatedToSosId: alert.id, closedAt: new Date(), checkinRespondedAt: new Date() },
      });
      return { escalated: true, sosAlertId: alert.id };
    }

    // OK — CAS back to MONITORING; if the sweep already escalated, the truth
    // is the truth: help is on the way, tell the caller instead of lying.
    const now = new Date();
    if (!session.checkinRequestedAt) throw new AppError(409, 'NO_CHECKIN_PENDING', 'There is no check-in waiting for a response.');
    const moved = await this.prisma.tripSafetySession.updateMany({
      where: { id: session.id, status: { in: ['MONITORING', 'CHECKIN_PENDING'] } },
      data: { status: 'MONITORING', checkinRespondedAt: now, checkinRequestedAt: null, checkinDeadlineAt: null },
    });
    if (moved.count === 0) {
      throw new AppError(409, 'CHECKIN_ALREADY_ESCALATED', 'This check-in already escalated — our safety team has been alerted.');
    }
    const state: DetectorState = (session.deviationState as DetectorState | null) ?? {};
    this.resetAfterAllClear(state, now, 'CHECKIN_OK');
    await this.prisma.tripSafetySession
      .update({ where: { id: session.id }, data: { deviationState: state as never } })
      .catch(() => {});
    return { escalated: false, status: 'MONITORING' };
  }

  /** Driver's "trip status OK" tap. Recorded in session state — at the L3
   *  deadline a responsive driver de-escalates instead of auto-SOS (§5.3).
   *  Never resolves the PASSENGER's pending check-in. */
  async driverConfirm(driverUserId: string) {
    const session = await this.prisma.tripSafetySession.findFirst({
      where: { driverUserId, status: { in: ['MONITORING', 'CHECKIN_PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) throw new NotFoundError('SafetyCheckin', driverUserId);
    const now = new Date();
    const state: DetectorState = (session.deviationState as DetectorState | null) ?? {};
    state.driverConfirmedAtMs = now.getTime();
    pushEvent(state, now, 'DRIVER_CONFIRMED');
    await this.prisma.tripSafetySession.update({ where: { id: session.id }, data: { deviationState: state as never } });
    this.warRoom('guardian:driver-confirmed', { sessionId: session.id, orderId: session.orderId });
    return { recorded: true };
  }

  /** Clear the anomaly latches and re-baseline the detectors after a human
   *  said things are fine — with a cooldown so the ladder doesn't nag. The
   *  event log keeps the whole history. */
  private resetAfterAllClear(state: DetectorState, now: Date, eventKind: string) {
    state.flags = { ...(state.flags?.staleGps ? { staleGps: state.flags.staleGps } : {}) };
    state.minDistToDestM = undefined;
    state.divergingSinceMs = null;
    state.stopAnchor = null;
    state.stopSinceMs = null;
    state.driverConfirmedAtMs = undefined;
    state.lastCheckinClearedAtMs = now.getTime();
    pushEvent(state, now, eventKind);
  }

  // ── Socket helpers — advisory only, never allowed to throw ──────────────

  private warRoom(event: string, payload: Record<string, unknown>) {
    try {
      this.io.to('ops:war-room').emit(event, payload);
    } catch { /* advisory only */ }
  }

  private roomEmit(room: string, event: string, payload: Record<string, unknown>) {
    try {
      this.io.to(room).emit(event, payload);
    } catch { /* advisory only */ }
  }
}
