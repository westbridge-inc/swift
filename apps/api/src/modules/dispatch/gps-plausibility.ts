import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { haversineDistance } from '../../utils/distance';
import { recordDecision } from '../algo/decisions';
import { log } from '../../utils/logger';

/**
 * [ALG-15] GPS plausibility — the floor every GPS-money guarantee rests on.
 *
 * Arrival evidence, the handover GPS a ReimbursementClaim is impossible
 * without, waiting-time money: all of it trusts the fix a device reports.
 * A client signal (Android's isFromMockProvider) is reported honestly and
 * can be patched out, so the part that matters is SERVER-SIDE physics:
 *
 *   IMPLAUSIBLE_SPEED   the distance between two consecutive fixes needs a
 *                       speed above `gps.maxPlausibleKmh` (140) — a teleport.
 *                       Fixes under 5 s or 50 m apart are jitter, ignored.
 *   MOCK_PROVIDER       the device said the fix came from a mock provider.
 *   PERFECT_ACCURACY    accuracy under 1 m is more suspicious than noise —
 *                       real receivers never report it.
 *   UNCORROBORATED      a claimed arrival with fewer than two fixes in the
 *                       preceding ten minutes — nothing supports the claim.
 *
 * Consequence is a FLAG and a row, never a penalty (L3): an AlgoDecision
 * with outcome FLAGGED / UNCORROBORATED that a reviewer reads. Absent or
 * degraded telemetry is never treated as fraud (L10): a missing previous
 * fix, accuracy or flag produces nothing. And the tell never leaks: no
 * response, no copy, no notification names a signal.
 */

export type GpsSignal = 'IMPLAUSIBLE_SPEED' | 'MOCK_PROVIDER' | 'PERFECT_ACCURACY';

export interface GpsFix {
  lat: number;
  lng: number;
  at: Date;
  accuracyM?: number | null;
  mocked?: boolean | null;
}

export interface GpsAssessment {
  signals: GpsSignal[];
  speedKmh: number | null;
  distanceM: number | null;
  elapsedS: number | null;
}

export const DEFAULT_MAX_PLAUSIBLE_KMH = 140;
const MIN_ELAPSED_S = 1;
const MIN_DISTANCE_M = 50;
const PERFECT_ACCURACY_M = 1;
// [ALG-16] Long enough to hold a whole delivery at one fix per 8 s (~96 min).
const TRACE_LENGTH = 720;
const TRACE_TTL_S = 3 * 60 * 60;
const FLAG_COOLDOWN_S = 10 * 60;
export const CORROBORATION_WINDOW_MS = 10 * 60 * 1000;
export const CORROBORATION_MIN_FIXES = 2;

export function assessFix(prev: GpsFix | null, next: GpsFix, opts: { maxPlausibleKmh?: number } = {}): GpsAssessment {
  const maxKmh = opts.maxPlausibleKmh ?? DEFAULT_MAX_PLAUSIBLE_KMH;
  const signals: GpsSignal[] = [];
  let speedKmh: number | null = null;
  let distanceM: number | null = null;
  let elapsedS: number | null = null;
  if (prev) {
    elapsedS = (next.at.getTime() - prev.at.getTime()) / 1000;
    distanceM = Math.round(haversineDistance(prev.lat, prev.lng, next.lat, next.lng) * 1000);
    // Jitter is a DISTANCE question, not a time one: under 50 m is receiver
    // noise whatever the clock says. Past that, speed is judged over at least
    // one second so a 30 km jump four seconds after the last fix is still the
    // teleport it is.
    if (elapsedS >= 0 && distanceM >= MIN_DISTANCE_M) {
      speedKmh = (distanceM / 1000) / (Math.max(elapsedS, MIN_ELAPSED_S) / 3600);
      if (speedKmh > maxKmh) signals.push('IMPLAUSIBLE_SPEED');
    }
  }
  if (next.mocked === true) signals.push('MOCK_PROVIDER');
  if (next.accuracyM != null && Number.isFinite(next.accuracyM) && next.accuracyM >= 0 && next.accuracyM < PERFECT_ACCURACY_M) {
    signals.push('PERFECT_ACCURACY');
  }
  return { signals, speedKmh: speedKmh == null ? null : Math.round(speedKmh), distanceM, elapsedS };
}

export const traceKey = (pool: 'RIDER' | 'DRIVER', moverId: string) => `gps:trace:${pool}:${moverId}`;

/** Keep the last fixes of a mover so a claimed arrival can be checked against
 *  the movement that led to it. Best-effort: Redis trouble never fails a fix. */
export async function pushTrace(redis: Redis, key: string, fix: GpsFix): Promise<void> {
  try {
    await redis.lpush(key, JSON.stringify({ lat: fix.lat, lng: fix.lng, at: fix.at.getTime() }));
    await redis.ltrim(key, 0, TRACE_LENGTH - 1);
    await redis.expire(key, TRACE_TTL_S);
  } catch (err) {
    log().warn({ err, key }, 'gps: trace write failed');
  }
}

export async function recentTrace(redis: Redis, key: string, sinceMs: number): Promise<Array<{ lat: number; lng: number; at: number }>> {
  try {
    const rows = await redis.lrange(key, 0, TRACE_LENGTH - 1);
    return rows
      .map((r) => { try { return JSON.parse(r) as { lat: number; lng: number; at: number }; } catch { return null; } })
      .filter((r): r is { lat: number; lng: number; at: number } => !!r && r.at >= sinceMs);
  } catch (err) {
    log().warn({ err, key }, 'gps: trace read failed');
    return [];
  }
}

/** A claimed arrival is corroborated when the trace shows the mover moving
 *  in the minutes before it. Fewer than two fixes is not fraud — it is an
 *  absence, and it is recorded as exactly that. */
export function arrivalCorroboration(trace: Array<{ at: number }>, declaredAt: Date): { corroborated: boolean; fixesInWindow: number } {
  const since = declaredAt.getTime() - CORROBORATION_WINDOW_MS;
  const fixesInWindow = trace.filter((f) => f.at >= since && f.at <= declaredAt.getTime()).length;
  return { corroborated: fixesInWindow >= CORROBORATION_MIN_FIXES, fixesInWindow };
}

/**
 * Write the flag — one AlgoDecision row, rate-limited to one per mover per
 * ten minutes so a bad receiver cannot flood the log. Never throws.
 */
export async function recordGpsFlag(
  deps: { prisma: PrismaClient; redis: Redis },
  flag: { pool: 'RIDER' | 'DRIVER'; moverId: string; outcome: 'FLAGGED' | 'UNCORROBORATED'; signals: string[]; inputs: Record<string, unknown>; sentence: string },
): Promise<boolean> {
  try {
    const gate = await deps.redis.set(`gps:flagged:${flag.pool}:${flag.moverId}:${flag.outcome}`, '1', 'EX', FLAG_COOLDOWN_S, 'NX');
    if (gate !== 'OK') return false;
  } catch (err) {
    log().warn({ err }, 'gps: flag cooldown read failed');
  }
  const id = await recordDecision(deps.prisma, {
    algo: 'ALG-15',
    subjectType: flag.pool,
    subjectId: flag.moverId,
    outcome: flag.outcome,
    sentence: flag.sentence,
    inputs: { signals: flag.signals, ...flag.inputs },
  });
  return id !== null;
}

export function flagSentence(signals: GpsSignal[], a: GpsAssessment): string {
  // Written for the reviewer, never shown to the mover.
  const parts: string[] = [];
  if (signals.includes('IMPLAUSIBLE_SPEED')) parts.push(`${a.distanceM} m in ${a.elapsedS}s (${a.speedKmh} km/h)`);
  if (signals.includes('MOCK_PROVIDER')) parts.push('the device reported a mock location provider');
  if (signals.includes('PERFECT_ACCURACY')) parts.push('the fix reported under 1 m accuracy');
  return `Position needs a look: ${parts.join('; ')}.`;
}
