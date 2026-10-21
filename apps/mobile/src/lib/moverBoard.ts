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
