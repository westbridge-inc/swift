import { instantOfGuyanaWallClock } from '../../utils/guyana-day';
import type { MmgCreationZone } from './mmg-checkout';
import type { MmgHistoryQuery } from './mmg-provider';

/** Existing MMG clock tolerance, shared by both history query callers. */
export const MMG_HISTORY_CLOCK_TOLERANCE_MS = 2 * 60_000;
/** How many history rows Swift asks for (MMG's `offset`). An answer this long may have been cut short. */
export const MMG_HISTORY_ROWS = 100;
/** How far beyond the accepted bounds the query reaches, so a payment just outside them is seen and held as outside. */
export const MMG_HISTORY_MARGIN_MS = 10 * 60_000;

/** An instant written the way MMG reads (and writes) its times, to the whole
 *  second: the inverse of mmgCreationInstant for the configured zone. */
export function mmgStampOf(instant: number, zone: MmgCreationZone, round: 'floor' | 'ceil' = 'floor'): string {
  const second = (round === 'ceil' ? Math.ceil(instant / 1000) : Math.floor(instant / 1000)) * 1000;
  if (zone === 'UTC') return new Date(second).toISOString();
  // Guyana wall clock: the face whose wall-clock reading is this instant.
  const shift = instantOfGuyanaWallClock(new Date(second)).getTime() - second;
  return new Date(second - shift).toISOString();
}

/** Both rails ask for the same padded interval, in MMG's clock convention.
 * The caller supplies its earliest upper bound (reply/deadline for checkout,
 * request deadline for push). Neither rail asks beyond the current instant. */
export function mmgHistoryQueryFor(from: Date, bound: Date, zone: MmgCreationZone, now: Date): MmgHistoryQuery {
  const start = from.getTime() - MMG_HISTORY_CLOCK_TOLERANCE_MS - MMG_HISTORY_MARGIN_MS;
  const end = bound.getTime() + MMG_HISTORY_CLOCK_TOLERANCE_MS + MMG_HISTORY_MARGIN_MS;
  return { fromdate: mmgStampOf(start, zone), todate: mmgStampOf(Math.min(end, now.getTime()), zone, 'ceil'), rows: MMG_HISTORY_ROWS };
}

/** MMG's offset is a row count, oldest first: reaching it may hide more rows. */
export function mmgHistoryTruncated(rowsReturned: number, query: MmgHistoryQuery): boolean {
  return rowsReturned >= query.rows;
}
