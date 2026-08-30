import { assessFix, type GpsFix } from './gps-plausibility';
import { traceLengthKm, type TracePoint } from '../../providers/maps/maps-provider';

/**
 * [ALG-16] A bounded trace cleaner, run ONCE at completion for money — never
 * per ping. Live display keeps the app's cheap interpolation.
 *
 *   1. order by time, drop exact duplicates;
 *   2. drop every fix that fails plausibility against the last KEPT fix
 *      (ALG-15's speed rule — a teleport never becomes distance);
 *   3. a 3-point median filter on latitude and longitude to take the shake
 *      out of a hand-held receiver without inventing a path.
 *
 * What comes out is what a map matcher is given. Nothing here is a guess:
 * a trace too short to clean is returned as it came.
 */

export interface RawFix {
  lat: number;
  lng: number;
  at: number;
}

export interface CleanedTrace {
  points: TracePoint[];
  dropped: number;
  rawKm: number;
  cleanKm: number;
}

function median3(a: number, b: number, c: number): number {
  return [a, b, c].sort((x, y) => x - y)[1]!;
}

export function cleanTrace(raw: RawFix[], opts: { maxPlausibleKmh?: number } = {}): CleanedTrace {
  const ordered = [...raw]
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng) && Number.isFinite(f.at))
    .sort((a, b) => a.at - b.at)
    .filter((f, i, arr) => i === 0 || !(f.lat === arr[i - 1]!.lat && f.lng === arr[i - 1]!.lng && f.at === arr[i - 1]!.at));
  const rawKm = traceLengthKm(ordered.map((f) => ({ lat: f.lat, lng: f.lng })));

  const kept: RawFix[] = [];
  let dropped = raw.length - ordered.length;
  for (const f of ordered) {
    const prev = kept[kept.length - 1];
    const prevFix: GpsFix | null = prev ? { lat: prev.lat, lng: prev.lng, at: new Date(prev.at) } : null;
    const a = assessFix(prevFix, { lat: f.lat, lng: f.lng, at: new Date(f.at) }, opts);
    if (a.signals.includes('IMPLAUSIBLE_SPEED')) { dropped += 1; continue; }
    kept.push(f);
  }

  const points: TracePoint[] = kept.length < 3
    ? kept.map((f) => ({ lat: f.lat, lng: f.lng, at: f.at }))
    : kept.map((f, i) => {
        if (i === 0 || i === kept.length - 1) return { lat: f.lat, lng: f.lng, at: f.at };
        const p = kept[i - 1]!; const n = kept[i + 1]!;
        return { lat: median3(p.lat, f.lat, n.lat), lng: median3(p.lng, f.lng, n.lng), at: f.at };
      });
  return { points, dropped, rawKm, cleanKm: traceLengthKm(points) };
}
