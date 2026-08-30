import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { haversineDistance } from '../../utils/distance';
import { algoConfig } from '../algo/algo-config';
import { recordDecision } from '../algo/decisions';
import { CORROBORATION_WINDOW_MS, recentTrace, traceKey } from '../dispatch/gps-plausibility';
import { cashRulesFor } from '../cash/cash-rules.service';
import { CountryConfigService } from '../country/country-config.service';
import { log } from '../../utils/logger';

/**
 * [ALG-30] Cherry-picking and fake-completion detectors — ADVISORY.
 *
 * Two shapes of gaming the delivery rail, both detected here and both
 * answered the same way: an AlgoDecision row (algo ALG-30) with the evidence
 * attached and a sentence written for the REVIEWER. That row is the whole
 * output. Nothing here changes what the rider gets back from the route,
 * nothing penalises, nothing is shown to the rider — the tell never leaks
 * (Kerb §5.3). A reviewer reads the rows through GET /admin/integrity/flags.
 *
 *   Cherry-picking  — accept, look at the leg, hand it back inside the
 *                     window (`gaming.cherryWindowS`, default 90 s). Kerb
 *                     §5.3 names it CHERRY_WINDOW_S. On this rail the only
 *                     rider-side "cancel" of an accepted leg IS the handback;
 *                     declining an offer is never an input here — declining
 *                     is never punished.
 *   Fake completion — a DELIVERED with no position near the drop in the ten
 *                     minutes before it, a handover position far from the
 *                     drop, or a mock-location flag (ALG-15) shortly before.
 *
 * Laws honoured here:
 *   L3   flag never penalty — a row is the only output.
 *   L10  absence is never fraud — an EMPTY trace (ALG-15 off, background
 *        location dead, Redis flushed) writes nothing; only fixes that exist
 *        and are ALL far from the drop are evidence. A missing acceptedAt
 *        writes nothing.
 *   ONE DEFINITION IMPORTED — the drop radius is the cash rail's
 *        `maxHandoverDistanceKm` (per country), the look-back window is
 *        ALG-15's `CORROBORATION_WINDOW_MS`. Neither is re-expressed here.
 */

export type GamingSignal = 'QUICK_HANDBACK' | 'NO_FIX_NEAR_DROP' | 'DECLARED_FAR' | 'MOCK_LOCATION_RECENT';

export const ALGO_ID = 'ALG-30';
export const CHERRY_PICK_OUTCOME = 'CHERRY_PICK_SUSPECTED';
export const FAKE_COMPLETION_OUTCOME = 'FAKE_COMPLETION_SUSPECTED';
/** How far back a mock-location flag counts against a completion. */
export const MOCK_LOOKBACK_MS = 60 * 60 * 1000;
/** The clustering window for "how many handbacks lately". */
export const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;

const round2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

// ---------------------------------------------------------------------------
// Pure decisions — no I/O, fully testable.
// ---------------------------------------------------------------------------

export interface HandbackFacts {
  acceptedAt: Date | null;
  handedBackAt: Date;
  windowS: number;
}

export function cherryPickSignals(f: HandbackFacts): { signals: GamingSignal[]; secondsAfterAccept: number | null } {
  if (!f.acceptedAt) return { signals: [], secondsAfterAccept: null };
  const secondsAfterAccept = Math.max(0, Math.round((f.handedBackAt.getTime() - f.acceptedAt.getTime()) / 1000));
  return { signals: secondsAfterAccept <= f.windowS ? ['QUICK_HANDBACK'] : [], secondsAfterAccept };
}

export interface CompletionFacts {
  drop: { lat: number; lng: number } | null;
  radiusKm: number;
  /** The fixes recorded in the window before completion (may be empty). */
  trace: Array<{ lat: number; lng: number; at: number }>;
  /** The rider's own handover position, when the route carries one. */
  declared: { lat: number; lng: number } | null;
  /** The most recent ALG-15 mock-provider flag inside the look-back, if any. */
  mockFlagAt: Date | null;
}

export interface CompletionAssessment {
  signals: GamingSignal[];
  fixesInWindow: number;
  nearestFixKm: number | null;
  declaredKm: number | null;
}

export function completionSignals(f: CompletionFacts): CompletionAssessment {
  const signals: GamingSignal[] = [];
  let nearestFixKm: number | null = null;
  let declaredKm: number | null = null;
  if (f.drop) {
    const { lat, lng } = f.drop;
    if (f.trace.length) {
      nearestFixKm = Math.min(...f.trace.map((p) => haversineDistance(p.lat, p.lng, lat, lng)));
      if (nearestFixKm > f.radiusKm) signals.push('NO_FIX_NEAR_DROP');
    }
    if (f.declared) {
      declaredKm = haversineDistance(f.declared.lat, f.declared.lng, lat, lng);
      if (declaredKm > f.radiusKm) signals.push('DECLARED_FAR');
    }
  }
  if (f.mockFlagAt) signals.push('MOCK_LOCATION_RECENT');
  return { signals, fixesInWindow: f.trace.length, nearestFixKm: round2(nearestFixKm), declaredKm: round2(declaredKm) };
}

/** Written for the reviewer, never shown to the rider. One sentence, ≤ 240 chars. */
export function completionSentence(a: CompletionAssessment, ctx: { radiusKm: number; windowMinutes: number; mockMinutesAgo: number | null }): string {
  const parts: string[] = [];
  if (a.signals.includes('NO_FIX_NEAR_DROP')) {
    parts.push(`no position within ${ctx.radiusKm} km of the drop in the ${ctx.windowMinutes} min before (${a.fixesInWindow} fixes, nearest ${a.nearestFixKm} km)`);
  }
  if (a.signals.includes('DECLARED_FAR')) parts.push(`the handover position was ${a.declaredKm} km from the drop`);
  if (a.signals.includes('MOCK_LOCATION_RECENT')) parts.push(`a mock location provider was flagged ${ctx.mockMinutesAgo ?? 0} min earlier`);
  return `Completion needs a look: ${parts.join('; ')}.`;
}

export function cherryPickSentence(ctx: {
  secondsAfterAccept: number; windowS: number; handbacks24h: number; quickHandbacks24h: number;
  basket: number; legKm: number | null; reason: string;
}): string {
  const reason = ctx.reason.length > 60 ? `${ctx.reason.slice(0, 57)}…` : ctx.reason;
  const leg = ctx.legKm == null ? '' : `, leg ${ctx.legKm} km`;
  return `Handed back ${ctx.secondsAfterAccept} s after accepting (window ${ctx.windowS} s): ${ctx.handbacks24h} handbacks in 24 h, ${ctx.quickHandbacks24h} quick; basket ${ctx.basket}${leg}; reason “${reason}”.`;
}

// ---------------------------------------------------------------------------
// The hooks — each returns whether a row was written; never throws.
// ---------------------------------------------------------------------------

export interface GamingDeps {
  prisma: PrismaClient;
  redis: Redis;
}

export interface HandbackEvent {
  riderId: string;
  /** The rider's USER id — the status log's `changedBy`. */
  riderUserId: string;
  orderId: string;
  reason: string;
  acceptedAt: Date | null;
  handedBackAt: Date;
  /** subtotalBase — the basket the rider looked at. */
  basket: number;
  pickup: { lat: number; lng: number } | null;
  drop: { lat: number; lng: number } | null;
}

async function enabled(prisma: PrismaClient): Promise<boolean> {
  return (await algoConfig(prisma, 'ALG-30.enabled')).value === true;
}

export async function assessHandback(deps: GamingDeps, ev: HandbackEvent): Promise<boolean> {
  try {
    if (!(await enabled(deps.prisma))) return false;
    const cfg = await algoConfig(deps.prisma, 'gaming.cherryWindowS');
    const windowS = Math.min(3600, Math.max(10, Number(cfg.value) || 0));
    const { signals, secondsAfterAccept } = cherryPickSignals({ acceptedAt: ev.acceptedAt, handedBackAt: ev.handedBackAt, windowS });
    if (!signals.length || secondsAfterAccept == null) return false;

    const since = new Date(ev.handedBackAt.getTime() - CLUSTER_WINDOW_MS);
    const [handbacks24h, priorQuick] = await Promise.all([
      deps.prisma.orderStatusLog.count({
        where: { changedBy: ev.riderUserId, note: { startsWith: 'Rider handback:' }, createdAt: { gte: since } },
      }),
      deps.prisma.algoDecision.count({
        where: { algo: ALGO_ID, subjectType: 'RIDER', subjectId: ev.riderId, outcome: CHERRY_PICK_OUTCOME, shadow: false, createdAt: { gte: since } },
      }),
    ]);
    const quickHandbacks24h = priorQuick + 1;
    const legKm = ev.pickup && ev.drop ? round2(haversineDistance(ev.pickup.lat, ev.pickup.lng, ev.drop.lat, ev.drop.lng)) : null;
    const basket = Number.isFinite(ev.basket) ? Math.round(ev.basket) : 0;

    const id = await recordDecision(deps.prisma, {
      algo: ALGO_ID,
      subjectType: 'RIDER',
      subjectId: ev.riderId,
      outcome: CHERRY_PICK_OUTCOME,
      sentence: cherryPickSentence({ secondsAfterAccept, windowS, handbacks24h: Math.max(handbacks24h, 1), quickHandbacks24h, basket, legKm, reason: ev.reason }),
      inputs: {
        signals, orderId: ev.orderId, secondsAfterAccept, windowS, basket, legKm,
        handbacks24h: Math.max(handbacks24h, 1), quickHandbacks24h, reason: ev.reason,
      },
      configVersion: cfg.version,
    });
    return id !== null;
  } catch (err) {
    log().warn({ err, orderId: ev.orderId }, 'rider-gaming: handback assessment failed');
    return false;
  }
}

export interface CompletionEvent {
  riderId: string;
  orderId: string;
  completedAt: Date;
  /** The rider's own handover position (cash handover); absent on PIN completion. */
  declared?: { lat: number; lng: number } | null;
}

export async function assessCompletion(deps: GamingDeps, ev: CompletionEvent): Promise<boolean> {
  try {
    if (!(await enabled(deps.prisma))) return false;
    const order = await deps.prisma.order.findUnique({
      where: { id: ev.orderId },
      select: { deliveryLat: true, deliveryLng: true, customer: { select: { countryCode: true } } },
    });
    if (!order) return false;
    const drop = order.deliveryLat != null && order.deliveryLng != null ? { lat: order.deliveryLat, lng: order.deliveryLng } : null;
    const rules = await cashRulesFor(new CountryConfigService(deps.prisma), order.customer.countryCode);
    const radiusKm = rules.maxHandoverDistanceKm;

    const sinceMs = ev.completedAt.getTime() - CORROBORATION_WINDOW_MS;
    const trace = (await recentTrace(deps.redis, traceKey('RIDER', ev.riderId), sinceMs)).filter((p) => p.at <= ev.completedAt.getTime() + 1000);
    const mock = await deps.prisma.algoDecision.findFirst({
      where: {
        algo: 'ALG-15', subjectType: 'RIDER', subjectId: ev.riderId, outcome: 'FLAGGED', shadow: false,
        createdAt: { gte: new Date(ev.completedAt.getTime() - MOCK_LOOKBACK_MS) },
        inputs: { path: ['signals'], array_contains: ['MOCK_PROVIDER'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const a = completionSignals({ drop, radiusKm, trace, declared: ev.declared ?? null, mockFlagAt: mock?.createdAt ?? null });
    if (!a.signals.length) return false;

    const windowMinutes = Math.round(CORROBORATION_WINDOW_MS / 60_000);
    const mockMinutesAgo = mock ? Math.max(0, Math.round((ev.completedAt.getTime() - mock.createdAt.getTime()) / 60_000)) : null;
    const id = await recordDecision(deps.prisma, {
      algo: ALGO_ID,
      subjectType: 'RIDER',
      subjectId: ev.riderId,
      outcome: FAKE_COMPLETION_OUTCOME,
      sentence: completionSentence(a, { radiusKm, windowMinutes, mockMinutesAgo }),
      inputs: {
        signals: a.signals, orderId: ev.orderId, radiusKm, windowMinutes,
        fixesInWindow: a.fixesInWindow, nearestFixKm: a.nearestFixKm, declaredKm: a.declaredKm,
        mockFlagAt: mock?.createdAt.toISOString() ?? null,
      },
    });
    return id !== null;
  } catch (err) {
    log().warn({ err, orderId: ev.orderId }, 'rider-gaming: completion assessment failed');
    return false;
  }
}
