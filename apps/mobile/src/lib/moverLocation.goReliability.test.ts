import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDeviceLocationLease,
  DEVICE_LOCATION_SETTLE_TIMEOUT_MS,
  grantedLocationFix,
  resolveCoordinatedDeviceLocation,
  settleDeviceLocation,
  type DeviceLocationApi,
  type DeviceLocationWriter,
  type LocationStatus,
} from './deviceLocation';
import { prepareMoverOnline } from './moverLocation';
import { BALANCED_FIX_TIMEOUT_MS, type PositionFix } from './positionFix';

// ---------------------------------------------------------------------------
// [GO-RELIABILITY] GO said "Couldn't get your location" in under a second with
// every permission granted. The real coordinator, resolver, GPS fallback and
// prepareMoverOnline run here; only the device is faked, the way Android
// behaves:
//  - expo-location's permission request always opens the system permission
//    screen, even when access is already granted;
//  - closing it resumes the app, and React Native reports 'active' (which
//    starts App's silent location re-check) BEFORE it delivers the result;
//  - every native call answers one hop later.
// So GO's own check runs one hop ahead of a newer re-check that supersedes it.
// ---------------------------------------------------------------------------

const HOP_MS = 10;
const nativeHop = <T>(value: () => T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value()), HOP_MS));

const GPS_FIX = { latitude: 6.8105, longitude: -58.1505 };
const gpsFix = (): PositionFix => ({ coords: { ...GPS_FIX, accuracy: 5 }, timestamp: Date.now() });

/** The shared location store, as useLocationStore keeps it. */
function store() {
  let status: LocationStatus = 'unknown';
  let latitude: number | null = null;
  let longitude: number | null = null;
  const writer: DeviceLocationWriter = {
    setStatus: (next) => {
      status = next;
    },
    setLocation: (nextLatitude, nextLongitude) => {
      latitude = nextLatitude;
      longitude = nextLongitude;
      status = 'granted';
    },
  };
  return {
    writer,
    status: () => status,
    /** MoverHomeScreen's getForegroundFix, verbatim. */
    foregroundFix: () => {
      if (!createLiveDeviceLocationLease()) return null;
      return grantedLocationFix(latitude, longitude, status);
    },
  };
}

function android(
  shared: ReturnType<typeof store>,
  device: {
    balanced: () => Promise<PositionFix>;
    lastKnown?: () => Promise<PositionFix | null>;
    gps?: () => Promise<PositionFix>;
    geocode?: () => Promise<Array<{ name?: string; city?: string }>>;
  },
) {
  const resumeChecks: Promise<unknown>[] = [];
  const api: DeviceLocationApi = {
    getForegroundPermissionsAsync: vi.fn(() => nativeHop(() => ({ status: 'granted' }))),
    requestForegroundPermissionsAsync: vi.fn(async () => {
      // The permission screen flashes and closes; the resume comes first.
      await nativeHop(() => undefined);
      resumeChecks.push(resolveCoordinatedDeviceLocation('silent', api, shared.writer));
      return { status: 'granted' };
    }),
    getCurrentPositionAsync: vi.fn(device.balanced),
    getLastKnownPositionAsync: vi.fn(device.lastKnown ?? (() => nativeHop(() => null))),
    getHighAccuracyPositionAsync: vi.fn(device.gps ?? (() => nativeHop(() => { throw new Error('no GPS fix'); }))),
    reverseGeocodeAsync: vi.fn(device.geocode ?? (() => nativeHop(() => [{ name: 'Regent Street', city: 'Georgetown' }]))),
  };
  return { api, resumeChecks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The i-th pending native request (the test has already waited for it). */
function nth<T>(list: T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no request #${index}`);
  return item;
}

function goOnlineWith(shared: ReturnType<typeof store>, api: DeviceLocationApi) {
  const goOnline = vi.fn().mockResolvedValue(undefined);
  let answered = false;
  const pending = prepareMoverOnline({
    resolveForeground: () => resolveCoordinatedDeviceLocation('request', api, shared.writer),
    requestBackground: vi.fn().mockResolvedValue(true),
    getForegroundFix: shared.foregroundFix,
    goOnline,
  }).finally(() => {
    answered = true;
  });
  return { pending, goOnline, answered: () => answered };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('[GO-RELIABILITY] GO waits for the newest location answer instead of failing fast', () => {
  it('settles at once, leaving no timer behind, when nothing is resolving', async () => {
    vi.useFakeTimers();
    await expect(settleDeviceLocation()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stationary phone where only GPS answers: GO waits for the re-check its own permission screen started, then goes online on the GPS fix', async () => {
    vi.useFakeTimers();
    const shared = store();
    const GPS_STEP_MS = 8_000;
    const device = android(shared, {
      // No network location: Balanced never answers (bounded by the resolver).
      balanced: () => new Promise<PositionFix>(() => {}),
      // Parked: the last fix is accurate but three minutes old, so it is history.
      lastKnown: () => nativeHop(() => ({
        coords: { latitude: 6.79, longitude: -58.16, accuracy: 5 },
        timestamp: Date.now() - 3 * 60_000,
      })),
      gps: () => new Promise<PositionFix>((resolve) => setTimeout(() => resolve(gpsFix()), GPS_STEP_MS)),
    });

    const go = goOnlineWith(shared, device.api);

    // GO's own check: request hop + Balanced budget + cached hop + GPS + geocode hop.
    const goCheckDone = HOP_MS + BALANCED_FIX_TIMEOUT_MS + HOP_MS + GPS_STEP_MS + HOP_MS;
    await vi.advanceTimersByTimeAsync(goCheckDone + HOP_MS / 2);
    expect(device.resumeChecks).toHaveLength(1);
    expect(device.api.getHighAccuracyPositionAsync).toHaveBeenCalledTimes(2);
    // GO's check answered, but the newer re-check is still on its GPS step:
    // a fix is still coming, so GO must not have given up.
    expect(go.answered()).toBe(false);
    expect(go.goOnline).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOP_MS * 2);
    await expect(go.pending).resolves.toMatchObject({ status: 'granted' });
    expect(go.goOnline).toHaveBeenCalledOnce();
    expect(go.goOnline).toHaveBeenCalledWith(GPS_FIX);
    expect(shared.status()).toBe('granted');
  });

  it('a newer re-check that starts while GO waits is waited for as well', async () => {
    const shared = store();
    const balanced: Array<ReturnType<typeof deferred<PositionFix>>> = [];
    const device = android(shared, {
      balanced: () => {
        const next = deferred<PositionFix>();
        balanced.push(next);
        return next.promise;
      },
    });

    const go = goOnlineWith(shared, device.api);
    await vi.waitFor(() => expect(balanced).toHaveLength(2));

    // GO's own check (one hop ahead) answers first and is superseded.
    nth(balanced, 0).resolve(gpsFix());
    await vi.waitFor(() => expect(device.api.reverseGeocodeAsync).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, HOP_MS * 3));
    expect(go.answered()).toBe(false);

    // The driver glances at another app and comes back: another re-check.
    const second = resolveCoordinatedDeviceLocation('silent', device.api, shared.writer);
    await vi.waitFor(() => expect(balanced).toHaveLength(3));

    // The first re-check answers, but it is no longer the newest: keep waiting.
    nth(balanced, 1).resolve(gpsFix());
    await device.resumeChecks[0];
    await new Promise((resolve) => setTimeout(resolve, HOP_MS * 3));
    expect(go.answered()).toBe(false);
    expect(go.goOnline).not.toHaveBeenCalled();

    nth(balanced, 2).resolve(gpsFix());
    await second;
    await expect(go.pending).resolves.toMatchObject({ status: 'granted' });
    expect(go.goOnline).toHaveBeenCalledWith(GPS_FIX);
  });

  it('a re-check that never answers holds GO busy only up to the bound, then GO refuses without going online', async () => {
    vi.useFakeTimers();
    const shared = store();
    let geocodes = 0;
    const stuck = deferred<Array<{ name?: string; city?: string }>>();
    const device = android(shared, {
      balanced: () => nativeHop(() => gpsFix()),
      // GO's own check labels its fix; the re-check's label request does not return.
      geocode: () => (geocodes++ === 0
        ? nativeHop(() => [{ name: 'Regent Street', city: 'Georgetown' }])
        : stuck.promise),
    });

    const go = goOnlineWith(shared, device.api);
    try {
      // GO's own check answered within a few hops; GO keeps waiting for the re-check.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(geocodes).toBe(2);
      expect(go.answered()).toBe(false);

      await vi.advanceTimersByTimeAsync(DEVICE_LOCATION_SETTLE_TIMEOUT_MS - 2_000);
      expect(go.answered()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(go.pending).resolves.toEqual({ status: 'unavailable' });
      expect(go.goOnline).not.toHaveBeenCalled();
    } finally {
      // Release the stuck re-check so the shared coordinator is idle for the next test.
      stuck.resolve([]);
      await Promise.all(device.resumeChecks);
    }
  });
});
