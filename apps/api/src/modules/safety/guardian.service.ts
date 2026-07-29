import type { PrismaClient, TripSafetySession, GuardianCloseReason } from '@prisma/client';
import type { Server } from 'socket.io';
import { haversineDistance } from '../../utils/distance';
import { log } from '../../utils/logger';

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
// This slice (M4b) runs the detectors to L1 — silent flags + war-room
// advisory. The graduated check-in ladder (L2 soft / L3 hard / L4 auto-SOS)
// builds on these flags in the next slice (§5.3).
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
 *  Only the sweep reads/writes it; decisions land in typed columns. */
interface DetectorState {
  minDistToDestM?: number;
  divergingSinceMs?: number | null;
  stopAnchor?: { lat: number; lng: number } | null;
  stopSinceMs?: number | null;
  flags?: { deviation?: string; longStop?: string; overdue?: string; staleGps?: string };
  events?: Array<{ t: string; kind: string; detail?: Record<string, unknown> }>;
}

const metersBetween = (aLat: number, aLng: number, bLat: number, bLng: number) =>
  haversineDistance(aLat, aLng, bLat, bLng) * 1000;

const pushEvent = (state: DetectorState, now: Date, kind: string, detail?: Record<string, unknown>) => {
  state.events = [...(state.events ?? []), { t: now.toISOString(), kind, ...(detail ? { detail } : {}) }].slice(-40);
};

/** Order statuses a Guardian session monitors. The moment an order leaves
 *  this set the session closes (reconciled by the sweep — no lifecycle hooks
 *  in the ride routes, so no shared-code writes). */
const MONITORED_ORDER_STATUS = 'RIDE_IN_PROGRESS';
const OPEN_SESSION_STATUSES = ['MONITORING', 'CHECKIN_PENDING', 'ESCALATING'] as const;

export interface GuardianSweepResult {
  opened: number;
  closed: number;
  flagged: number;
}

export class GuardianService {
  constructor(private prisma: PrismaClient, private io: Server) {}

  /** One tick: open sessions for newly-in-progress rides, run detectors on
   *  live ones, close sessions whose ride ended. Idempotent and safe to
   *  overlap — every mutation is create-unique or compare-and-set. */
  async sweep(now = new Date()): Promise<GuardianSweepResult> {
    const opened = await this.openNewSessions(now);
    const { closed, flagged } = await this.reconcileOpenSessions(now);
    return { opened, closed, flagged };
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
          try {
            this.io.to('ops:war-room').emit('guardian:high-risk', {
              sessionId: session.id,
              orderId: order.id,
              riskScore: score,
              riskFactors: factors,
              openedAt: now.toISOString(),
            });
          } catch { /* advisory only */ }
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

  // ── Reconcile: run detectors on live sessions, close finished ones ──────

  private async reconcileOpenSessions(now: Date): Promise<{ closed: number; flagged: number }> {
    const sessions = await this.prisma.tripSafetySession.findMany({
      where: { status: { in: [...OPEN_SESSION_STATUSES] } },
      take: 500,
    });
    if (sessions.length === 0) return { closed: 0, flagged: 0 };

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
    for (const session of sessions) {
      const order = byId.get(session.orderId);
      if (!order) {
        // Order hard-deleted underneath the session (test fixtures, purges) —
        // close rather than monitor a ghost forever.
        closed += await this.close(session, 'TRIP_CANCELLED', now);
        continue;
      }
      if (order.status !== MONITORED_ORDER_STATUS) {
        const reason: GuardianCloseReason = order.status === 'CANCELLED' ? 'TRIP_CANCELLED' : 'TRIP_COMPLETED';
        closed += await this.close(session, reason, now);
        continue;
      }
      flagged += await this.runDetectors(session, order, now);
    }
    return { closed, flagged };
  }

  private async close(session: TripSafetySession, reason: GuardianCloseReason, now: Date): Promise<number> {
    // CAS on the open statuses so a racing tick closes exactly once.
    const moved = await this.prisma.tripSafetySession.updateMany({
      where: { id: session.id, status: { in: [...OPEN_SESSION_STATUSES] } },
      data: { status: 'CLOSED', closeReason: reason, closedAt: now },
    });
    return moved.count;
  }

  /** L1 detectors (§5.2). Each flag fires ONCE per session (the flag itself is
   *  the dedup), lands in the event log, and pings the war-room as advisory.
   *  Returns how many NEW flags this tick raised. */
  private async runDetectors(
    session: TripSafetySession,
    order: {
      id: string;
      pickedUpAt: Date | null;
      taxiDuration: number | null;
      pickupLat: unknown;
      pickupLng: unknown;
      deliveryLat: unknown;
      deliveryLng: unknown;
      driver: { currentLat: number | null; currentLng: number | null; lastLocationUpdate: Date | null } | null;
    },
    now: Date,
  ): Promise<number> {
    const state: DetectorState = ((session.deviationState as DetectorState | null) ?? {});
    state.flags = state.flags ?? {};
    const band = riskBand(session.riskScore);
    let newFlags = 0;

    const raise = (kind: keyof NonNullable<DetectorState['flags']>, detail: Record<string, unknown>) => {
      state.flags![kind] = now.toISOString();
      pushEvent(state, now, `FLAG_${kind.replace(/([A-Z])/g, '_$1').toUpperCase()}`, detail);
      newFlags += 1;
      log().warn({ sessionId: session.id, orderId: session.orderId, kind, ...detail }, 'Trip Guardian detector flag');
      try {
        this.io.to('ops:war-room').emit('guardian:flag', {
          sessionId: session.id,
          orderId: session.orderId,
          kind,
          riskScore: session.riskScore,
          band: BAND_NAMES[band],
          at: now.toISOString(),
          ...detail,
        });
      } catch { /* advisory only */ }
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
    // holder offline); it also gates the ladder later: "telemetry still
    // anomalous" must never rest on a frozen fix.
    const fixAt = fix?.lastLocationUpdate ?? null;
    if (fixAt && now.getTime() - fixAt.getTime() > staleGpsMinutes() * 60_000) {
      if (!state.flags.staleGps) raise('staleGps', { lastFixAt: fixAt.toISOString() });
    } else if (state.flags.staleGps) {
      // Telemetry recovered — clear so a later real stall is caught again.
      delete state.flags.staleGps;
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
      const distToDest = metersBetween(lat, lng, dest.lat, dest.lng);

      // Divergence ratchet (§5.2, adapted — see header).
      const prevMin = state.minDistToDestM;
      state.minDistToDestM = prevMin == null ? distToDest : Math.min(prevMin, distToDest);
      const threshold = deviationMeters()[band];
      const diverging = distToDest > state.minDistToDestM + threshold;
      if (diverging) {
        state.divergingSinceMs = state.divergingSinceMs ?? fixAt.getTime();
        const sustainedMs = fixAt.getTime() - state.divergingSinceMs;
        if (sustainedMs >= sustainSeconds() * 1000 && !state.flags.deviation) {
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
        if (stoppedMs >= stopMinutes()[band] * 60_000 && !state.flags.longStop) {
          raise('longStop', { stoppedMinutes: Math.round(stoppedMs / 60_000), anchor: state.stopAnchor });
        }
      } else {
        state.stopAnchor = { lat, lng };
        state.stopSinceMs = fixAt.getTime();
      }
    }

    // Overdue (§5.2): now past planned ETA + max(floor, 50% of the plan).
    if (session.plannedEtaAt && !state.flags.overdue) {
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

    await this.prisma.tripSafetySession.update({
      where: { id: session.id },
      data: {
        deviationState: state as never,
        ...(isFreshFix && fixAt ? { lastLocationAt: fixAt } : {}),
      },
    });
    return newFlags;
  }
}
