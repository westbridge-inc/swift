import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [GO-LOC-1] The device's ways to a position, and every caller wired to them.
//
// Android answers a Balanced request from Wi-Fi and cell towers; with no
// network location it never answers. The expo source must ask Balanced first,
// then the OS's cached fix with the age and accuracy limits, then High
// accuracy (GPS). And the two callers that need a CURRENT fix — the location
// resolver behind GO, pickup and SOS, and the mover's stationary heartbeat —
// must both go through it, never straight to a Balanced request again.
// Comments are stripped before the source pins so a comment cannot satisfy one.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  getCurrentPositionAsync: vi.fn(),
  getLastKnownPositionAsync: vi.fn(),
}));
vi.mock('expo-location', () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  getCurrentPositionAsync: fx.getCurrentPositionAsync,
  getLastKnownPositionAsync: fx.getLastKnownPositionAsync,
}));

import { currentDevicePosition, expoPositionSource } from './devicePosition';

const GPS = { coords: { latitude: 6.4012, longitude: -58.6202, accuracy: 8 }, timestamp: Date.now() };

beforeEach(() => {
  vi.useFakeTimers();
  fx.getCurrentPositionAsync.mockReset();
  fx.getLastKnownPositionAsync.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('the expo source', () => {
  it('Balanced first; then the cached fix within 60 s and 100 m; then High accuracy', async () => {
    fx.getCurrentPositionAsync.mockImplementation(({ accuracy }: { accuracy: number }) => (accuracy === 3 ? new Promise(() => {}) : Promise.resolve(GPS)));
    fx.getLastKnownPositionAsync.mockResolvedValue(null);
    let fix: unknown;
    void currentDevicePosition().then((value) => { fix = value; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fix, 'no fix within half a minute with no network location').toMatchObject({ coords: GPS.coords, source: 'gps' });
    expect(fx.getCurrentPositionAsync.mock.calls.map(([options]) => options)).toEqual([{ accuracy: 3 }, { accuracy: 4 }]);
    expect(fx.getLastKnownPositionAsync).toHaveBeenCalledWith({ maxAge: 60_000, requiredAccuracy: 100 });
  });

  it('cached: false (the lease heartbeat) never reads the cached fix, even a fresh one', async () => {
    fx.getCurrentPositionAsync.mockImplementation(({ accuracy }: { accuracy: number }) => (accuracy === 3 ? Promise.reject(new Error('Location provider is unavailable')) : Promise.resolve(GPS)));
    fx.getLastKnownPositionAsync.mockResolvedValue({ coords: { latitude: 6.79, longitude: -58.16, accuracy: 5 }, timestamp: Date.now() });
    await expect(currentDevicePosition({ cached: false })).resolves.toMatchObject({ source: 'gps' });
    expect(fx.getLastKnownPositionAsync).not.toHaveBeenCalled();
  });

  it('each way is the request it names', async () => {
    fx.getCurrentPositionAsync.mockResolvedValue(GPS);
    fx.getLastKnownPositionAsync.mockResolvedValue(null);
    await expoPositionSource.balanced();
    await expoPositionSource.gps();
    await expoPositionSource.lastKnown();
    expect(fx.getCurrentPositionAsync.mock.calls).toEqual([[{ accuracy: 3 }], [{ accuracy: 4 }]]);
    expect(fx.getLastKnownPositionAsync).toHaveBeenCalledTimes(1);
  });
});

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const RESOLVER_HOOK = strip(readFileSync(new URL('../hooks/useDeviceLocation.ts', import.meta.url), 'utf8'));
const MOVER_HOOKS = strip(readFileSync(new URL('../hooks/mover.ts', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('every caller that needs a current fix goes through the fallback', () => {
  it('the location resolver behind GO, pickup and SOS gets all three ways from the source', () => {
    const api = body(RESOLVER_HOOK, 'const deviceLocationApi', '};');
    expect(api).toContain('getCurrentPositionAsync: expoPositionSource.balanced');
    expect(api).toContain('getLastKnownPositionAsync: expoPositionSource.lastKnown');
    expect(api).toContain('getHighAccuracyPositionAsync: expoPositionSource.gps');
    expect(RESOLVER_HOOK).not.toContain('Location.getCurrentPositionAsync(');
  });

  it('the mover’s stationary heartbeat renews its lease through the fallback, never from a cached fix', () => {
    // The heartbeat publishes no fix time: the server takes it as "now", so a
    // cached fix would renew the lease with an old position. Balanced or GPS only.
    const heartbeat = body(MOVER_HOOKS, 'refreshForegroundSample:', 'commitSharedSample:');
    expect(heartbeat).toContain('await currentDevicePosition({ cached: false })');
    expect(heartbeat).not.toContain('Location.getCurrentPositionAsync(');
  });

  it('the handover / fare-outcome evidence fix falls back through the bounded policy, never a bare Balanced wait', () => {
    const fix = body(MOVER_HOOKS, 'async function evidenceFix', 'export function useDriverAction');
    expect(fix).toContain('await currentDevicePosition()');
    expect(fix).not.toContain('Location.getCurrentPositionAsync(');
  });
});
