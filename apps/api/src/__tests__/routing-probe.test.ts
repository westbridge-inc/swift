import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoutingProbe, probeRouting, ROUTING_PROBE_TIMEOUT_MS, ROUTING_PROBE_TTL_MS } from '../providers/maps/routing-probe';
import type { RouteEstimate } from '../providers/maps/maps-provider';

const env = { NODE_ENV: 'production', MAPS_PROVIDER: 'osrm' };
const road: RouteEstimate = { km: 8.1, minutes: 15, source: 'osrm' };
const fallback: RouteEstimate = { km: 1.2, minutes: null, source: 'haversine' };
afterEach(() => vi.useRealTimers());

describe('routing probe', () => {
  it('recognises a real road answer and refuses a straight-line fallback', async () => {
    expect(await probeRouting({ routeKm: async () => road }, env)).toEqual({ status: 'ok', provider: 'osrm', km: 8.1 });
    expect(await probeRouting({ routeKm: async () => fallback }, env)).toMatchObject({ status: 'degraded', provider: 'osrm' });
  });
  it.each([0, -1, Infinity, NaN])('an unusable road distance %s is degraded', async (km) => {
    expect(await probeRouting({ routeKm: async () => ({ ...road, km }) }, env)).toMatchObject({ status: 'degraded' });
  });
  it('does not publish provider URLs or exception details', async () => {
    const result = await probeRouting({ routeKm: async () => { throw new Error('private-provider-detail'); } }, { ...env, OSRM_URL: 'http://private-provider.test' });
    expect(result.status).toBe('degraded');
    expect(JSON.stringify(result)).not.toContain('private-provider');
  });
  it.each([undefined, 'haversine', 'google', 'invalid'])('production provider %s cannot claim healthy road routing', async (provider) => {
    const routeKm = vi.fn(async () => fallback);
    expect(await probeRouting({ routeKm }, { NODE_ENV: 'production', MAPS_PROVIDER: provider })).toMatchObject({ status: 'degraded' });
    expect(routeKm).not.toHaveBeenCalled();
  });
  it.each(['development', 'test'])('%s keeps the configured local provider without an external probe', async (mode) => {
    const routeKm = vi.fn(async () => fallback);
    expect(await probeRouting({ routeKm }, { NODE_ENV: mode })).toMatchObject({ status: 'skipped' });
    expect(routeKm).not.toHaveBeenCalled();
  });
  it('shares an in-flight probe and refreshes both a later outage and recovery', async () => {
    vi.useFakeTimers();
    const routeKm = vi.fn(async () => road);
    const check = createRoutingProbe({ routeKm }, env);
    const first = check();
    expect(check()).toBe(first);
    expect((await first).status).toBe('ok');
    routeKm.mockResolvedValue(fallback);
    await vi.advanceTimersByTimeAsync(ROUTING_PROBE_TTL_MS - 1);
    expect((await check()).status).toBe('ok');
    expect(routeKm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await check()).status).toBe('degraded');
    routeKm.mockResolvedValue(road);
    await vi.advanceTimersByTimeAsync(ROUTING_PROBE_TTL_MS);
    expect((await check()).status).toBe('ok');
    expect(routeKm).toHaveBeenCalledTimes(3);
  });
  it('bounds a provider that never answers', async () => {
    vi.useFakeTimers();
    const check = createRoutingProbe({ routeKm: () => new Promise<RouteEstimate>(() => {}) }, env);
    const result = check();
    await vi.advanceTimersByTimeAsync(ROUTING_PROBE_TIMEOUT_MS);
    expect(await result).toMatchObject({ status: 'degraded' });
  });
});
