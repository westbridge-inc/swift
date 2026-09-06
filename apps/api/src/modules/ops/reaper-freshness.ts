/**
 * [DOC-1 §9.2 · P9-2] Reaper failure or lag beyond two cycles is an LB-0
 * alarm — silence is not success.
 *
 * The retention reaper records a heartbeat in platform_config when a sweep
 * completes; nothing else may write it. An hourly check reads it: no
 * heartbeat ever, an unreadable one, or one older than two cycles pages the
 * admins (once per window) and sets the gauge. A sweep that throws pages
 * immediately from the job, before the lag would ever be noticed.
 */
import type { PrismaClient } from '@prisma/client';
import { reaperGauge } from '../../plugins/observability';

export const LAST_REAPER_RUN_KEY = 'last_reaper_run_at';
/** The reaper runs daily (the expiry sweep); two cycles is the spec's lag bound. */
export const REAPER_CYCLE_HOURS = 24;
export const REAPER_MAX_LAG_CYCLES = 2;

export interface ReaperFreshness {
  stale: boolean;
  ageHours: number | null;
  reason: string;
}

/** Written by the reaper itself at the end of a completed sweep. */
export async function recordReaperRun(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  await prisma.platformConfig.upsert({
    where: { key: LAST_REAPER_RUN_KEY },
    create: { key: LAST_REAPER_RUN_KEY, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
}

export async function checkReaperFreshness(prisma: PrismaClient, now: Date = new Date()): Promise<ReaperFreshness> {
  const maxAgeHours = REAPER_CYCLE_HOURS * REAPER_MAX_LAG_CYCLES;
  const last = await prisma.platformConfig.findUnique({ where: { key: LAST_REAPER_RUN_KEY } });
  if (!last) {
    return { stale: true, ageHours: null, reason: 'The retention reaper has never completed a sweep. Nothing has been purged on schedule.' };
  }
  const at = new Date(String(last.value).replace(/^"|"$/g, ''));
  if (Number.isNaN(at.getTime())) return { stale: true, ageHours: null, reason: 'The reaper heartbeat is unreadable.' };
  const ageHours = (now.getTime() - at.getTime()) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return { stale: true, ageHours, reason: `The retention reaper last completed ${ageHours.toFixed(1)}h ago — more than ${REAPER_MAX_LAG_CYCLES} cycles. Documents past retention are not being purged.` };
  }
  return { stale: false, ageHours, reason: 'fresh' };
}

/** Publish the state; the caller pages. */
export function publishReaperFreshness(f: ReaperFreshness): void {
  reaperGauge.labels('fresh').set(f.stale ? 0 : 1);
  reaperGauge.labels('stale').set(f.stale ? 1 : 0);
  reaperGauge.labels('age_hours').set(f.ageHours ?? -1);
}
