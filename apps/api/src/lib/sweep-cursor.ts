import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { log } from '../utils/logger';
import { sweepGauge } from '../plugins/observability';

/**
 * [S-05] Fixed unpaginated safety sweeps can starve people forever.
 *
 * Stop-ship register S-05: every safety sweep read a fixed `take` from the
 * top of its population and processed that. Once the population exceeded
 * the cap — or the earliest rows kept failing and stayed eligible — the rows
 * past the cap were never visited: rides never got a Guardian session,
 * evidence trails were never appended, SLA breaches were never paged.
 *
 * Every sweep now walks its population in ORDERED KEYSET PAGES from a
 * PERSISTED CURSOR: each tick handles the next page after the last id it
 * finished, a short page completes the pass and wraps to the top, so every
 * eligible row is visited within one full pass — ceil(population / page)
 * ticks — regardless of size. A row whose handler throws is recorded as
 * poison (failures, last error) and the cursor moves past it: one bad row
 * never blocks the rest. The pass ages and the poison list are the
 * observable SLO; the tick pages humans on a stalled pass or a row that
 * keeps failing, not on processed counts.
 */
export const POISON_PAGE_FAILURES = 3;
export const POISON_LIST_CAP = 200;

export function sweepMaxPassSeconds(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env['SWEEP_MAX_PASS_SECONDS'] ?? 900);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

export type PoisonEntry = { failures: number; lastError: string; lastAt: string };
export type PoisonMap = Record<string, PoisonEntry>;

export interface SweepPageOptions<T extends { id: string }> {
  pageSize: number;
  /** The next page of eligible rows strictly after `afterId`, ordered by id ascending. */
  fetch: (afterId: string | null, limit: number) => Promise<T[]>;
  /** Handle one row; a throw marks the row poison for this pass and moves on. */
  handle: (row: T) => Promise<void>;
  /** Optional population counts for the SLO gauges: total eligible, and eligible after the cursor. */
  count?: (afterId: string | null) => Promise<number>;
  now?: Date;
  /** Pages drained per call (default 1): a tick keeps going, page after
   *  persisted page, until the pass completes or this budget is spent — the
   *  cursor survives a crash between pages, and no single query grows. */
  maxPages?: number;
}

export interface SweepPageResult {
  visited: number;
  failed: number;
  passCompleted: boolean;
  /** Row ids that failed on this page. */
  poisoned: string[];
}

/** One tick of one sweep: up to `maxPages` pages from the persisted cursor. */
export async function sweepPage<T extends { id: string }>(prisma: PrismaClient, workType: string, opts: SweepPageOptions<T>): Promise<SweepPageResult> {
  const budget = Math.max(1, Math.floor(opts.maxPages ?? 1));
  const total: SweepPageResult = { visited: 0, failed: 0, passCompleted: false, poisoned: [] };
  for (let page = 0; page < budget; page += 1) {
    const r = await sweepOnePage(prisma, workType, opts);
    total.visited += r.visited; total.failed += r.failed; total.poisoned.push(...r.poisoned);
    if (r.passCompleted) { total.passCompleted = true; break; }
  }
  return total;
}

async function sweepOnePage<T extends { id: string }>(prisma: PrismaClient, workType: string, opts: SweepPageOptions<T>): Promise<SweepPageResult> {
  const now = opts.now ?? new Date();
  const pageSize = Math.max(1, Math.floor(opts.pageSize));
  const cursor = await prisma.sweepCursor.upsert({ where: { workType }, create: { workType }, update: {} });
  const poison: PoisonMap = (cursor.poison as PoisonMap | null) ?? {};
  const startingPass = cursor.cursorId === null;
  const rows = await opts.fetch(cursor.cursorId, pageSize);

  let visited = 0;
  let failed = 0;
  const poisoned: string[] = [];
  for (const row of rows) {
    try {
      await opts.handle(row);
      visited += 1;
      if (poison[row.id]) delete poison[row.id];
    } catch (err) {
      failed += 1;
      poisoned.push(row.id);
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const prev = poison[row.id];
      poison[row.id] = { failures: (prev?.failures ?? 0) + 1, lastError: message, lastAt: now.toISOString() };
      log().error({ err, workType, rowId: row.id, failures: poison[row.id]!.failures }, '[S-05] sweep row failed — recorded as poison, continuing past it');
    }
  }
  // Bound the poison list: keep the most recent entries.
  const entries = Object.entries(poison).sort((a, b) => (a[1].lastAt < b[1].lastAt ? 1 : -1)).slice(0, POISON_LIST_CAP);
  const boundedPoison: PoisonMap = Object.fromEntries(entries);

  const passCompleted = rows.length < pageSize; // a short page is the end of the population
  const lastId = rows.length > 0 ? rows[rows.length - 1]!.id : null;
  await prisma.sweepCursor.update({
    where: { workType },
    data: {
      cursorId: passCompleted ? null : lastId,
      ...(startingPass ? { passStartedAt: now, lastPassVisited: 0, lastPassFailed: 0 } : {}),
      lastPassVisited: { increment: visited },
      lastPassFailed: { increment: failed },
      ...(passCompleted ? { passCompletedAt: now, passesCompleted: { increment: 1 } } : {}),
      lastPageAt: now,
      lastPageSize: rows.length,
      poison: boundedPoison as Prisma.InputJsonValue,
    },
  });
  if (opts.count) {
    const [population, unvisited] = await Promise.all([opts.count(null), passCompleted ? Promise.resolve(0) : opts.count(lastId)]);
    sweepGauge.labels(workType, 'population').set(population);
    sweepGauge.labels(workType, 'unvisited_in_pass').set(unvisited);
  }
  sweepGauge.labels(workType, 'poison_rows').set(entries.length);
  return { visited, failed, passCompleted, poisoned };
}

export interface SweepScanRow {
  workType: string;
  /** Seconds since the last completed pass (0 when none yet completed and no pass in flight). */
  passAgeSeconds: number;
  /** Seconds the current pass has been running (0 when not in flight). */
  currentPassSeconds: number;
  stalled: boolean;
  poison: Array<{ id: string; failures: number; lastError: string }>;
  repeatPoison: Array<{ id: string; failures: number; lastError: string }>;
}

/** [S-05 · operations] Maximum due age and the unvisited/poison population,
 *  per sweep — what the tick pages on. */
export async function scanSweeps(prisma: PrismaClient, now = new Date()): Promise<SweepScanRow[]> {
  const cursors = await prisma.sweepCursor.findMany({ orderBy: { workType: 'asc' } });
  const max = sweepMaxPassSeconds();
  return cursors.map((c) => {
    const poison = Object.entries((c.poison as PoisonMap | null) ?? {}).map(([id, e]) => ({ id, failures: e.failures, lastError: e.lastError }));
    const currentPassSeconds = c.cursorId !== null && c.passStartedAt ? Math.max(0, Math.round((now.getTime() - c.passStartedAt.getTime()) / 1000)) : 0;
    const passAgeSeconds = c.passCompletedAt ? Math.max(0, Math.round((now.getTime() - c.passCompletedAt.getTime()) / 1000)) : currentPassSeconds;
    const stalled = currentPassSeconds > max || (c.passCompletedAt !== null && passAgeSeconds > max && c.cursorId !== null);
    sweepGauge.labels(c.workType, 'pass_age_seconds').set(passAgeSeconds);
    sweepGauge.labels(c.workType, 'current_pass_seconds').set(currentPassSeconds);
    sweepGauge.labels(c.workType, 'stalled').set(stalled ? 1 : 0);
    return { workType: c.workType, passAgeSeconds, currentPassSeconds, stalled, poison, repeatPoison: poison.filter((p) => p.failures >= POISON_PAGE_FAILURES) };
  });
}
