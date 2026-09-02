import type { PrismaClient, TripSafetySession, GuardianCloseReason, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { haversineDistance } from '../../utils/distance';
import { log } from '../../utils/logger';
import { AppError, NotFoundError } from '../../utils/errors';
import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { guardianDriverConfirmCounter } from '../../plugins/observability';
import { sweepPage } from '../../lib/sweep-cursor';
import { stageCheckinDeliveries, drainCheckinDeliveries, hardPromptState, checkinDeliveryKilled, passengerAsk, driverAsk, type CheckinDeliveryObserver } from './guardian-delivery';
import { guardianDeliveryCounter } from '../../plugins/observability';
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
/** [S-05] Page sizes for the two Guardian sweeps — the population is walked
 *  in keyset pages from a persisted cursor, never a fixed take. */
const openPageSize = () => num('GUARDIAN_SWEEP_PAGE_SIZE', 200);
const reconcilePageSize = () => num('GUARDIAN_RECONCILE_PAGE_SIZE', 500);
/** [S-05] Pages a tick may drain: a bounded budget, never the whole table in one query. */
const sweepMaxPages = () => num('SWEEP_MAX_PAGES_PER_TICK', 10);
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
  /** [S-04] The hard-check cycle the session is in: minted at L3 with a
   *  one-time driver nonce, replaced by the next L3, and the ONLY thing a
   *  driver confirmation can answer. */
  checkinCycle?: { id: string; requestedAtMs: number; level?: 'SOFT' | 'HARD'; hardRequestedAtMs?: number; driverNonceHash?: string; driverNonceUsedAtMs?: number; undeliveredPagedAtMs?: number };
  /** [S-04] The driver's confirmation, bound to a cycle, with who / which
   *  device / when — a stale one can never absolve a later cycle. */
  driverConfirm?: { cycleId: string; atMs: number; actorUserId: string; deviceId: string | null };
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
/** [S-04] Rollback: a driver confirmation never de-escalates an unanswered
 *  hard check — the auto-SOS proceeds rather than accepting any driver proof. */
const driverDeescalationKilled = () => process.env['GUARDIAN_DRIVER_DEESCALATION_KILL'] === '1';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** [S-04] A driver confirmation counts only for the cycle it answers,
 *  made after that cycle asked. */
const confirmBoundToCycle = (state: DetectorState): boolean =>
  Boolean(state.checkinCycle && state.driverConfirm && state.driverConfirm.cycleId === state.checkinCycle.id && state.driverConfirm.atMs >= (state.checkinCycle.hardRequestedAtMs ?? state.checkinCycle.requestedAtMs));

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

  /** [S-05] Test seams: run before a row is handled by a sweep — a throw is a
   *  poison row. `cursorKey` isolates a test's cursors. Never set in routes. */
  observer: { beforeOpen?: (orderId: string) => Promise<void>; beforeReconcile?: (sessionId: string) => Promise<void>; /** [S-06] runs after an ask's commit and BEFORE its inline delivery — a throw is the process dying between the two */ afterAsk?: (sessionId: string) => Promise<void>; beforeDeliver?: CheckinDeliveryObserver['beforeDeliver'] } = {};
  private sweepOpts: { openPageSize?: number; reconcilePageSize?: number; cursorKey?: string; maxPages?: number };
  constructor(private prisma: PrismaClient, private io: Server, sweepOpts: { openPageSize?: number; reconcilePageSize?: number; cursorKey?: string; maxPages?: number } = {}) {
    this.notifications = new NotificationService(prisma, io);
    this.sos = new SosService(prisma, io);
    this.sweepOpts = sweepOpts;
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
    let opened = 0;
    const where = { orderType: 'TAXI', status: MONITORED_ORDER_STATUS, driverId: { not: null } } satisfies Prisma.OrderWhereInput;
    // [S-05] One keyset page per tick from the persisted cursor: every live
    // ride is visited within one pass whatever the population; a ride whose
    // open fails is poison for this pass and the cursor moves past it.
    await sweepPage(this.prisma, `guardian.open${this.sweepOpts.cursorKey ? `:${this.sweepOpts.cursorKey}` : ''}`, {
      pageSize: this.sweepOpts.openPageSize ?? openPageSize(),
      maxPages: this.sweepOpts.maxPages ?? sweepMaxPages(),
      now,
      count: (afterId) => this.prisma.order.count({ where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) } }),
      fetch: async (afterId, limit) => {
        const live = await this.prisma.order.findMany({
          where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            // [F-028-05] The sweep runs from a WORKER — no request context, so the
            // tenant-scope extension stamps nothing. The order's own tenant is in
            // hand and authoritative; fetch it or the session silently takes the
            // schema default, `swift-default`.
            tenantId: true,
            customerId: true,
            pickedUpAt: true,
            taxiDuration: true,
            driver: { select: { userId: true, createdAt: true, totalRides: true } },
          },
          take: limit,
        });
        if (live.length === 0) return [];
        const existing = await this.prisma.tripSafetySession.findMany({ where: { orderId: { in: live.map((o) => o.id) } }, select: { orderId: true } });
        const known = new Set(existing.map((s) => s.orderId));
        return live.map((order) => ({ ...order, known: known.has(order.id) }));
      },
      handle: async (order) => {
        await this.observer.beforeOpen?.(order.id);
        if (order.known || !order.driver) return;
        const { score, factors } = await this.scoreRisk(order, now);
        const plannedEtaAt =
          order.pickedUpAt && order.taxiDuration
            ? new Date(order.pickedUpAt.getTime() + order.taxiDuration * 60_000)
            : null;
        try {
          const session = await this.prisma.tripSafetySession.create({
            data: {
              // [F-028-05] Stamped explicitly, because this create happens in a
              // background sweep with no tenant ALS. Omitting it made every
              // guardian session `swift-default` — and TripSafetySession is
              // tenant-scoped on the READ side, so a tenant-B passenger's
              // authenticated check-in could not find their own ride's session:
              // NEED_HELP threw NotFound instead of raising the promised
              // immediate SOS. A safety net that cannot be reached by the person
              // it is protecting is not a safety net.
              tenantId: order.tenantId,
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
      },
    });
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
    let closed = 0;
    let flagged = 0;
    let escalated = 0;
    const where = { status: { in: [...OPEN_SESSION_STATUSES] } } satisfies Prisma.TripSafetySessionWhereInput;
    // [S-05] Keyset pages from the persisted cursor; a session whose tick
    // throws is poison for this pass — the rest of the page still runs.
    await sweepPage(this.prisma, `guardian.reconcile${this.sweepOpts.cursorKey ? `:${this.sweepOpts.cursorKey}` : ''}`, {
      pageSize: this.sweepOpts.reconcilePageSize ?? reconcilePageSize(),
      maxPages: this.sweepOpts.maxPages ?? sweepMaxPages(),
      now,
      count: (afterId) => this.prisma.tripSafetySession.count({ where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) } }),
      fetch: async (afterId, limit) => {
        const sessions = await this.prisma.tripSafetySession.findMany({ where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: limit });
        if (sessions.length === 0) return [];
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
        return sessions.map((session) => ({ ...session, order: byId.get(session.orderId) ?? null }));
      },
      handle: async ({ order, ...session }) => {
        await this.observer.beforeReconcile?.(session.id);
        const r = await this.reconcileOne(session as TripSafetySession, order, now);
        closed += r.closed; flagged += r.flagged; escalated += r.escalated;
      },
    });
    return { closed, flagged, escalated };
  }

  /** One session's tick: finish an escalation, close a finished ride, or run
   *  the detectors and the ladder. */
  private async reconcileOne(session: TripSafetySession, order: OrderSnapshot | null, now: Date): Promise<{ closed: number; flagged: number; escalated: number }> {

    // A session mid-escalation finishes its SOS hand-off BEFORE anything
    // else — even if the ride "completed" underneath it. A timed-out
    // check-in must not be silenced by whoever taps "complete ride"
    // (that could be the attacker); ops closes it, not the trip state.
    if (session.status === 'ESCALATING') {
      return { closed: 0, flagged: 0, escalated: await this.finishEscalation(session, order, now) };
    }

    if (!order) {
      // Order hard-deleted underneath the session (test fixtures, purges) —
      // close rather than monitor a ghost forever.
      return { closed: await this.close(session, 'TRIP_CANCELLED', now, null), flagged: 0, escalated: 0 };
    }
    if (order.status !== MONITORED_ORDER_STATUS) {
      const reason: GuardianCloseReason = order.status === 'CANCELLED' ? 'TRIP_CANCELLED' : 'TRIP_COMPLETED';
      return { closed: await this.close(session, reason, now, order), flagged: 0, escalated: 0 };
    }

    const state: DetectorState = (session.deviationState as DetectorState | null) ?? {};
    state.flags = state.flags ?? {};
    const { newFlags, freshFixAt } = this.runDetectors(session, order, state, now);
    const escalated = await this.evaluateLadder(session, order, state, now);
    await this.prisma.tripSafetySession
      .update({
        where: { id: session.id },
        data: { deviationState: state as never, ...(freshFixAt ? { lastLocationAt: freshFixAt } : {}) },
      })
      .catch(() => {}); // scratch-state write must never fail the tick
    return { closed: 0, flagged: newFlags, escalated };
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
    // §5.4 → §8: the post-trip flag IS the spec's low-priority S3 auto-case —
    // the case machine owns the ops surfacing and the pattern intelligence.
    const { IncidentService } = await import('./incident.service');
    await new IncidentService(this.prisma, this.io)
      .intake({
        category: 'COMPLETION_ANOMALY',
        intake: 'SYSTEM_AUTO',
        source: { type: 'GUARDIAN_COMPLETION', id: session.orderId },
        subjectUserId: session.driverUserId,
        reporterUserId: null,
        orderId: session.orderId,
        summary: `Taxi ride completed ${distM}m from its destination (tolerance ${completionToleranceM()}m) with no route update.`,
        details: { sessionId: session.id, distM, riskScore: session.riskScore },
      })
      .catch((err) => log().error({ err, sessionId: session.id }, 'completion sanity: incident intake failed — flag persisted anyway'));
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
      // [S-06] The ask IS a cycle, and the ask is a durable delivery
      // obligation: the cycle, the status change and the delivery rows commit
      // together. [S-04] A new climb owes nothing to the last one.
      const cycleId = nanoid(12);
      const committed: DetectorState = { ...state, checkinCycle: { id: cycleId, requestedAtMs: now.getTime(), level: 'SOFT' }, driverConfirm: undefined, driverConfirmedAtMs: undefined };
      const moved = await this.prisma.$transaction(async (tx) => {
        const m = await tx.tripSafetySession.updateMany({
          where: { id: session.id, status: 'MONITORING', checkinRequestedAt: null },
          // A fresh ask wipes any answer from a PREVIOUS ladder cycle — else a
          // stale respondedAt would block L3 forever on the second climb.
          data: { checkinRequestedAt: now, checkinRespondedAt: null, checkinDeadlineAt: null, deviationState: committed as never },
        });
        if (m.count !== 1) return 0;
        if (session.passengerUserId) {
          await stageCheckinDeliveries(tx, session, [{ cycleId, level: 'SOFT', recipient: 'PASSENGER', userId: session.passengerUserId, payload: passengerAsk(session, cycleId, 'SOFT', null) }]);
        }
        return 1;
      });
      if (moved === 1) {
        state.checkinCycle = committed.checkinCycle;
        state.driverConfirm = undefined;
        state.driverConfirmedAtMs = undefined;
        pushEvent(state, now, 'L2_SOFT_CHECKIN', { cycleId });
        await this.deliverAsks(session.id, now);
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
      // [S-04] This ask IS the cycle's hard half: the driver can only answer
      // it with the nonce it carries, once, while it is pending. The hash is
      // the record; the nonce travels only to the driver's own device.
      // [S-06] The status change and both delivery rows commit together.
      const driverNonce = randomBytes(16).toString('hex');
      const base = state.checkinCycle ?? { id: nanoid(12), requestedAtMs: now.getTime(), level: 'SOFT' as const };
      const hardCycle = { ...base, level: 'HARD' as const, hardRequestedAtMs: now.getTime(), driverNonceHash: sha256(driverNonce), driverNonceUsedAtMs: undefined, undeliveredPagedAtMs: undefined };
      const committed: DetectorState = { ...state, checkinCycle: hardCycle, driverConfirm: undefined, driverConfirmedAtMs: undefined };
      const moved = await this.prisma.$transaction(async (tx) => {
        const m = await tx.tripSafetySession.updateMany({
          where: { id: session.id, status: 'MONITORING', checkinRespondedAt: null },
          data: { status: 'CHECKIN_PENDING', checkinDeadlineAt: deadline, deviationState: committed as never },
        });
        if (m.count !== 1) return 0;
        const asks = [];
        if (session.passengerUserId) asks.push({ cycleId: hardCycle.id, level: 'HARD' as const, recipient: 'PASSENGER' as const, userId: session.passengerUserId, payload: passengerAsk(session, hardCycle.id, 'HARD', deadline) });
        // Low-key driver-side prompt (§5.3): a stopped driver with a flat
        // tire will answer — and that answer is a record.
        asks.push({ cycleId: hardCycle.id, level: 'HARD' as const, recipient: 'DRIVER' as const, userId: session.driverUserId, payload: driverAsk(session, hardCycle.id, driverNonce, deadline) });
        await stageCheckinDeliveries(tx, session, asks);
        return 1;
      });
      if (moved === 1) {
        state.checkinCycle = hardCycle;
        state.driverConfirm = undefined;
        state.driverConfirmedAtMs = undefined;
        pushEvent(state, now, 'L3_HARD_CHECKIN', { deadline: deadline.toISOString(), cycleId: hardCycle.id });
        await this.deliverAsks(session.id, now);
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
      // [S-06] A deadline runs only against a DELIVERED prompt. SENT runs the
      // policy below. PENDING / UNKNOWN (still owed, retrying, or the
      // rollback) HOLDS the deadline and pages a human once per cycle — an
      // undelivered prompt is never treated as an answered opportunity.
      // FAILED (every attempt exhausted) is the explicit no-delivery policy:
      // the person could not be reached at all and the anomaly stands, so the
      // ladder escalates and says why.
      if (session.passengerUserId) {
        const cycleId = state.checkinCycle?.id ?? null;
        const prompt = cycleId ? await hardPromptState(this.prisma, session.id, cycleId) : { state: 'UNKNOWN' as const, deliveredAt: null };
        if (prompt.state === 'FAILED' && !checkinDeliveryKilled()) {
          guardianDeliveryCounter.labels('deadline_without_delivery_escalated').inc();
          pushEvent(state, now, 'DEADLINE_WITHOUT_DELIVERY', { cycleId, delivery: prompt.state });
        } else if (prompt.state !== 'SENT' && prompt.state !== 'SKIPPED') {
          if (state.checkinCycle && !state.checkinCycle.undeliveredPagedAtMs) {
            state.checkinCycle.undeliveredPagedAtMs = now.getTime();
            pushEvent(state, now, 'DEADLINE_HELD_UNDELIVERED', { cycleId, delivery: prompt.state, killed: checkinDeliveryKilled() });
            guardianDeliveryCounter.labels('deadline_held').inc();
            await notifyAdmins(this.prisma, this.notifications, {
              tenantId: session.tenantId,
              title: 'Guardian: hard check-in not delivered — deadline held',
              body: `The hard safety check for order ${session.orderId} has not reached the passenger (delivery ${prompt.state.toLowerCase()}). The deadline is held and the worker keeps trying; please look at the trip now.`,
              data: { kind: 'guardian_checkin_undelivered', sessionId: session.id, orderId: session.orderId, cycleId, delivery: prompt.state },
            }).catch(() => 0);
          }
          return 0;
        }
      }
      // A responsive DRIVER blocks the auto-SOS (§5.3: "neither party
      // responsive") — the flat-tire case. [S-04] "Responsive" means a
      // confirmation bound to THIS cycle, made after this cycle asked. A tap
      // from ordinary MONITORING, or an answer to an earlier cycle, is a stale
      // fact: it is cleared, recorded, counted — and it absolves nothing.
      const bound = confirmBoundToCycle(state);
      if (!bound && (state.driverConfirmedAtMs || state.driverConfirm)) {
        guardianDriverConfirmCounter.labels('stale_value_cleared').inc();
        pushEvent(state, now, 'STALE_DRIVER_CONFIRM_IGNORED', { confirmCycleId: state.driverConfirm?.cycleId ?? null, cycleId: state.checkinCycle?.id ?? null });
        state.driverConfirm = undefined;
        state.driverConfirmedAtMs = undefined;
      }
      if (bound && driverDeescalationKilled()) {
        guardianDriverConfirmCounter.labels('deescalation_killed').inc();
        pushEvent(state, now, 'DRIVER_DEESCALATION_KILLED', { cycleId: state.checkinCycle?.id ?? null });
      }
      if (bound && !driverDeescalationKilled()) {
        const moved = await this.prisma.tripSafetySession.updateMany({
          where: { id: session.id, status: 'CHECKIN_PENDING' },
          data: { status: 'MONITORING', checkinRequestedAt: null, checkinDeadlineAt: null },
        });
        if (moved.count === 1) {
          const cycleId = state.checkinCycle?.id ?? null;
          this.resetAfterAllClear(state, now, 'DRIVER_CONFIRMED_DEESCALATE');
          guardianDriverConfirmCounter.labels('passenger_unanswered_deescalation').inc();
          this.warRoom('guardian:driver-confirmed', { sessionId: session.id, orderId: session.orderId, cycleId });
          // [S-04 · operations] A passenger who never answered a hard check is
          // a page, even when the driver vouched: a human looks, every time.
          await notifyAdmins(this.prisma, this.notifications, {
            tenantId: session.tenantId,
            title: 'Guardian: passenger unanswered, driver de-escalated',
            body: `The passenger on order ${session.orderId} never answered a hard safety check; the driver confirmed the trip status and the ladder stood down. Please look at the trip.`,
            data: { kind: 'guardian_deescalation', sessionId: session.id, orderId: session.orderId, cycleId },
          }).catch(() => 0);
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

  /**
   * IS A CHECK-IN WAITING FOR THIS PASSENGER RIGHT NOW?
   *
   * The check-in card was raised by ONE path: the `guardian:checkin` socket
   * event, handled by whichever screen happened to be mounted and listening.
   * A passenger whose app was backgrounded or killed — which is exactly when
   * the push matters — missed that event entirely, and nothing ever raised the
   * card again. They had a notification asking "Everything OK on your trip?"
   * and no way in the app to answer it. On a HARD check-in that silence has a
   * deadline, and the ladder escalates when it passes: the safety system would
   * treat a passenger who tried to answer as one who did not.
   *
   * So the phone can now ASK, instead of only being told. The lookup mirrors
   * `respondToCheckin` exactly — same where, same ordering — because a screen
   * that renders the card must agree with the route that accepts the answer;
   * two different notions of "the current session" is how a person gets a
   * prompt that 404s when they tap it.
   *
   * Outstanding means `checkinRequestedAt` is set and unanswered. Answering OK
   * nulls it, and escalation closes the session, so a stale prompt cannot
   * survive either ending. Still SERVER-OWNED: the deadline is the server's
   * timestamp, never computed here or on the phone.
   */
  async outstandingCheckin(passengerUserId: string) {
    const session = await this.prisma.tripSafetySession.findFirst({
      where: { passengerUserId, status: { in: ['MONITORING', 'CHECKIN_PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!session || !session.checkinRequestedAt || session.checkinRespondedAt) return null;
    return {
      sessionId: session.id,
      orderId: session.orderId,
      // L2 raises the request and leaves the session MONITORING; L3 moves it to
      // CHECKIN_PENDING and sets the deadline. The status IS the level.
      level: session.status === 'CHECKIN_PENDING' ? ('HARD' as const) : ('SOFT' as const),
      requestedAt: session.checkinRequestedAt.toISOString(),
      deadlineAt: session.checkinDeadlineAt ? session.checkinDeadlineAt.toISOString() : null,
    };
  }

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

  /** [S-06] Deliver what the session's asks own — inline, right now (the
   *  fail-safe path); anything that fails or is left over is the worker's. */
  private async deliverAsks(sessionId: string, now: Date): Promise<void> {
    await this.observer.afterAsk?.(sessionId);
    await drainCheckinDeliveries(this.prisma, this.notifications, { sessionIds: [sessionId], now, observer: { beforeDeliver: this.observer.beforeDeliver } });
  }

  /** [S-04] Driver's "trip status OK" — an ANSWER to the hard check the
   *  server asked for, never a standing tap. Accepted only while that cycle
   *  is pending, only with that cycle's one-time nonce, once; recorded with
   *  actor, device and time. A tap in ordinary MONITORING, an answer to an
   *  earlier cycle, a wrong nonce or a replay is refused and put on the
   *  record. Never resolves the PASSENGER's pending check-in. */
  async driverConfirm(driverUserId: string, input: { cycleId: string; nonce: string; deviceId?: string | null }) {
    const session = await this.prisma.tripSafetySession.findFirst({
      where: { driverUserId, status: { in: ['MONITORING', 'CHECKIN_PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) throw new NotFoundError('SafetyCheckin', driverUserId);
    const now = new Date();
    const state: DetectorState = (session.deviationState as DetectorState | null) ?? {};
    const refuse = async (event: string, code: string, message: string): Promise<never> => {
      guardianDriverConfirmCounter.labels(event).inc();
      pushEvent(state, now, 'DRIVER_CONFIRM_REFUSED', { code, cycleId: input.cycleId, currentCycleId: state.checkinCycle?.id ?? null, deviceId: input.deviceId ?? null });
      await this.prisma.tripSafetySession.update({ where: { id: session.id }, data: { deviationState: state as never } }).catch(() => {});
      this.warRoom('guardian:driver-confirm-refused', { sessionId: session.id, orderId: session.orderId, code, cycleId: input.cycleId });
      throw new AppError(409, code, message);
    };
    const cycle = state.checkinCycle;
    if (session.status !== 'CHECKIN_PENDING' || !cycle || !cycle.driverNonceHash) return refuse('no_hard_check_refused', 'NO_HARD_CHECK_PENDING', 'There is no trip status check waiting for you. A confirmation answers a check the server asked for.');
    if (input.cycleId !== cycle.id) return refuse('stale_confirm_refused', 'STALE_CONFIRM', 'That confirmation answers an earlier check. Please respond to the current one.');
    if (sha256(input.nonce) !== cycle.driverNonceHash) return refuse('bad_nonce_refused', 'BAD_CONFIRM_NONCE', 'The confirmation could not be verified.');
    if (cycle.driverNonceUsedAtMs) return refuse('nonce_reused_refused', 'CONFIRM_ALREADY_USED', 'This check was already answered.');
    cycle.driverNonceUsedAtMs = now.getTime();
    state.driverConfirm = { cycleId: cycle.id, atMs: now.getTime(), actorUserId: driverUserId, deviceId: input.deviceId ?? null };
    // Mirror for readers of the old field; never consulted for de-escalation.
    state.driverConfirmedAtMs = now.getTime();
    pushEvent(state, now, 'DRIVER_CONFIRMED', { cycleId: cycle.id, deviceId: input.deviceId ?? null });
    const moved = await this.prisma.tripSafetySession.updateMany({ where: { id: session.id, status: 'CHECKIN_PENDING' }, data: { deviationState: state as never } });
    if (moved.count !== 1) throw new AppError(409, 'NO_HARD_CHECK_PENDING', 'The check ended before your confirmation arrived.');
    guardianDriverConfirmCounter.labels('confirmed').inc();
    this.warRoom('guardian:driver-confirmed', { sessionId: session.id, orderId: session.orderId, cycleId: cycle.id });
    return { recorded: true, cycleId: cycle.id };
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
    state.driverConfirm = undefined;
    state.checkinCycle = undefined;
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
