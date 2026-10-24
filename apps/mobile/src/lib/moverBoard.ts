import type { MoverKind } from './moverLocation';

/**
 * [PERF partner #4] Whether the job board rests. A taxi driver carries one ride at a time
 * (by law), so the board is not read while they are on one: it used to poll every 10 s
 * through the whole ride, six wasted reads a minute, and its pins stayed on the map. It
 * reads again the moment the ride ends. A rider's board never rests: stacking lets a rider
 * carry 1 to 3 jobs.
 */
export function boardPaused(kind: MoverKind | null, onRide: boolean): boolean {
  return kind === 'DRIVER' && onRide;
}

/**
 * [#1919 review S4-1] The board's last answer is drawn only while it is recent. After a rest
 * (a ride, offline, the app in the background) the cache still holds the answer from before,
 * possibly 30+ minutes old; drawn again, a driver could tap a job that is long gone. An answer
 * older than three board polls at the slow-network pace (3 x 30 s) is not shown: the board stays
 * empty until the fresh read lands. An answer without a time (preview, tests) is shown as before.
 */
export const BOARD_MAX_AGE_MS = 90_000;
export function recentBoard<T>(data: T[] | undefined, updatedAt: number | undefined, now: number): T[] {
  if (!data) return [];
  if (!updatedAt) return data;
  return now - updatedAt > BOARD_MAX_AGE_MS ? [] : data;
}
