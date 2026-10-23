import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [TAXI route line · MAPS-CHECK G1] The seams that bring the road onto the
// driver's map, pinned in the source (the screen's drawing is proven by
// ActiveJobScreen.multistop.navigation.test.ts):
//
//   client: driverApi.rideRoute GETs the ride's route read
//   hook:   read once per ride and per skipped stop — a key OUTSIDE ['mover']
//           (a job step invalidates those), never polled, nothing in preview,
//           and any failure answers null (the straight line), silently
//   screen: the driver's live job feeds it, and both strokes draw
//           driverMapLine's coordinates, geodesic only when straight
//
// Comments are stripped first so a phrase in a comment can never satisfy an
// assertion about code (the hazard-matching rule).
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOOKS = strip(readFileSync(new URL('./mover.ts', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const SCREEN = strip(readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the client', () => {
  it('reads the ride’s route from the driver’s own ride', () => {
    expect(body(API, 'export const driverApi', '\n};')).toContain('rideRoute: (id: string) => api.get(`/driver/rides/${id}/route`)');
  });
});

describe('the hook', () => {
  const hook = body(HOOKS, 'export function useDriverRouteLine', '\n}\n');
  it('is keyed by the ride and its skipped stops, outside the mover keys a job step refreshes', () => {
    expect(hook).toContain("queryKey: ['driverRouteLine', rideId, skipped]");
    expect(hook).toContain('const skipped = skippedStopsKey(rideStops(job))');
    expect(hook).not.toMatch(/queryKey: \['mover'/);
  });
  it('is never polled, reads nothing in preview, and a failure is the straight line (null), silently', () => {
    expect(hook).not.toContain('refetchInterval');
    expect(hook).toContain('enabled: !!rideId && !pv');
    expect(hook).toMatch(/try \{\s*return await unwrap\(driverApi\.rideRoute\(rideId as string\)\);\s*\} catch \{\s*return null;\s*\}/);
    expect(hook).toContain('retry: false');
    expect(hook).toContain('meta: { silent: true }');
  });
});

describe('the screen', () => {
  it('feeds the hook the driver’s live job and draws driverMapLine on both strokes, geodesic only when straight', () => {
    expect(SCREEN).toContain('const roadLine = useDriverRouteLine(isDriver ? liveJob : null);');
    expect(SCREEN).toContain('const mapLine = driverMapLine(isDriver ? roadLine.data : null, routePoints);');
    const strokes = SCREEN.match(/<Polyline [^>]*\/>/g) ?? [];
    expect(strokes).toHaveLength(2);
    for (const stroke of strokes) {
      expect(stroke).toContain('coordinates={mapLine.coordinates}');
      expect(stroke).toContain('geodesic={!mapLine.road}');
    }
  });
});
