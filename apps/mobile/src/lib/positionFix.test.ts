import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALANCED_FIX_TIMEOUT_MS,
  GPS_FIX_TIMEOUT_MS,
  LAST_KNOWN_MAX_ACCURACY_M,
  LAST_KNOWN_MAX_AGE_MS,
  LAST_KNOWN_TIMEOUT_MS,
  PositionFixTimeoutError,
  currentPositionWithFallback,
  isUsableLastKnownFix,
  type PositionFix,
  type PositionSource,
} from './positionFix';

// [GO-LOC-1] Android serves Balanced from Wi-Fi and cell; with no network
// location it never answers. The fallback is bounded at every step.

const NOW = 1_800_000_000_000;
const BALANCED: PositionFix = { coords: { latitude: 6.8013, longitude: -58.1551, accuracy: 60 }, timestamp: NOW };
const GPS: PositionFix = { coords: { latitude: 6.4012, longitude: -58.6202, accuracy: 8 }, timestamp: NOW };
const never = <T,>() => new Promise<T>(() => {});

function source(overrides: Partial<PositionSource> = {}): PositionSource & { [K in keyof PositionSource]: ReturnType<typeof vi.fn> } {
  return {
    balanced: vi.fn(() => Promise.resolve(BALANCED)),
    lastKnown: vi.fn(() => Promise.resolve(null)),
    gps: vi.fn(() => Promise.resolve(GPS)),
    ...overrides,
  } as never;
}

/** Let every queued microtask (and the promise chain behind it) run. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Balanced answers: nothing else is asked', () => {
  it('uses the Balanced fix and never wakes the GPS', async () => {
    const s = source();
    await expect(currentPositionWithFallback(s, () => NOW)).resolves.toMatchObject({ ...BALANCED, source: 'balanced' });
    expect(s.lastKnown).not.toHaveBeenCalled();
    expect(s.gps).not.toHaveBeenCalled();
  });
});

describe('Balanced never answers (no network location): GPS after a bounded wait', () => {
  it('waits exactly the Balanced bound, then takes the GPS fix', async () => {
    const s = source({ balanced: vi.fn(() => never<PositionFix>()) });
    const result = currentPositionWithFallback(s, () => NOW);
    await vi.advanceTimersByTimeAsync(BALANCED_FIX_TIMEOUT_MS - 1);
    expect(s.gps, 'the GPS was asked before Balanced had its chance').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(s.lastKnown).toHaveBeenCalledTimes(1);
    expect(s.gps).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toMatchObject({ ...GPS, source: 'gps' });
  });

  it('a Balanced refusal (network location off) goes to the GPS at once, without the wait', async () => {
    const s = source({ balanced: vi.fn(() => Promise.reject(new Error('Location provider is unavailable'))) });
    await expect(currentPositionWithFallback(s, () => NOW)).resolves.toMatchObject({ source: 'gps' });
  });

  it('a Balanced answer that is not a position counts as no answer', async () => {
    const s = source({ balanced: vi.fn(() => Promise.resolve({ coords: { latitude: Number.NaN, longitude: -58.1 } })) });
    await expect(currentPositionWithFallback(s, () => NOW)).resolves.toMatchObject({ source: 'gps' });
  });

  it('nothing answers: it rejects after the bounds add up — it never hangs', async () => {
    const s = source({ balanced: vi.fn(() => never<PositionFix>()), lastKnown: vi.fn(() => never<PositionFix | null>()), gps: vi.fn(() => never<PositionFix>()) });
    let settled: unknown = 'pending';
    const result = currentPositionWithFallback(s, () => NOW).then(() => 'resolved', (e: unknown) => e);
    void result.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(BALANCED_FIX_TIMEOUT_MS + LAST_KNOWN_TIMEOUT_MS + GPS_FIX_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(settled).toBeInstanceOf(PositionFixTimeoutError);
    expect((settled as PositionFixTimeoutError).step).toBe('gps');
  });

  it('a GPS answer that is not a position is refused, never returned', async () => {
    const s = source({ balanced: vi.fn(() => Promise.reject(new Error('off'))), gps: vi.fn(() => Promise.resolve({ coords: { latitude: 6.4, longitude: Number.POSITIVE_INFINITY } })) });
    await expect(currentPositionWithFallback(s, () => NOW)).rejects.toThrow('not a position');
  });
});

describe('the cached fix: only fresh and accurate, then it saves the GPS wait', () => {
  /** `timestamp: null` = a cached fix that carries no time at all. */
  const cached = (ageMs: number, accuracy: number | null | undefined, timestamp: number | null = NOW - ageMs): PositionFix => ({
    coords: { latitude: 6.79, longitude: -58.16, ...(accuracy === undefined ? {} : { accuracy }) },
    ...(timestamp === null ? {} : { timestamp }),
  });

  it('a fresh, accurate cached fix is used and the GPS is never woken', async () => {
    const fix = cached(30_000, 40);
    const s = source({ balanced: vi.fn(() => Promise.reject(new Error('off'))), lastKnown: vi.fn(() => Promise.resolve(fix)) });
    await expect(currentPositionWithFallback(s, () => NOW)).resolves.toMatchObject({ ...fix, source: 'last-known' });
    expect(s.gps).not.toHaveBeenCalled();
  });

  it.each([
    ['older than the age limit', cached(LAST_KNOWN_MAX_AGE_MS + 1, 40)],
    ['less accurate than the limit', cached(1_000, LAST_KNOWN_MAX_ACCURACY_M + 1)],
    ['no reported accuracy', cached(1_000, null)],
    ['no accuracy field at all', cached(1_000, undefined)],
    ['no time', cached(1_000, 40, null)],
    ['from the future beyond the window', cached(-(LAST_KNOWN_MAX_AGE_MS + 1), 40)],
    ['not a position', { coords: { latitude: Number.NaN, longitude: -58.1, accuracy: 5 }, timestamp: NOW }],
  ] as const)('%s: not trusted; the GPS is asked', async (_label, fix) => {
    const s = source({ balanced: vi.fn(() => Promise.reject(new Error('off'))), lastKnown: vi.fn(() => Promise.resolve(fix as PositionFix)) });
    await expect(currentPositionWithFallback(s, () => NOW)).resolves.toMatchObject({ ...GPS, source: 'gps' });
  });

  it('the limits themselves are inside: exactly the age limit and exactly the accuracy limit are usable', () => {
    expect(isUsableLastKnownFix(cached(LAST_KNOWN_MAX_AGE_MS, LAST_KNOWN_MAX_ACCURACY_M), NOW)).toBe(true);
    expect(isUsableLastKnownFix(cached(LAST_KNOWN_MAX_AGE_MS + 1, LAST_KNOWN_MAX_ACCURACY_M), NOW)).toBe(false);
    expect(isUsableLastKnownFix(cached(0, LAST_KNOWN_MAX_ACCURACY_M + 0.5), NOW)).toBe(false);
    expect(isUsableLastKnownFix(cached(0, -1), NOW)).toBe(false);
  });

  it('a caller that must not use a cached fix (the lease heartbeat) never gets one, however fresh', async () => {
    const fix = cached(1_000, 5);
    const s = source({ balanced: vi.fn(() => Promise.reject(new Error('off'))), lastKnown: vi.fn(() => Promise.resolve(fix)) });
    await expect(currentPositionWithFallback(s, () => NOW, { cached: false })).resolves.toMatchObject({ ...GPS, source: 'gps' });
    expect(s.lastKnown).not.toHaveBeenCalled();
  });

  it('a cached lookup that hangs is bounded too', async () => {
    const s = source({ balanced: vi.fn(() => Promise.reject(new Error('off'))), lastKnown: vi.fn(() => never<PositionFix | null>()) });
    const result = currentPositionWithFallback(s, () => NOW);
    await vi.advanceTimersByTimeAsync(LAST_KNOWN_TIMEOUT_MS);
    await flush();
    await expect(result).resolves.toMatchObject({ source: 'gps' });
  });
});
