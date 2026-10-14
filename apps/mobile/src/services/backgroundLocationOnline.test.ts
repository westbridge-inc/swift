import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';
import { createMoverLocationController, MOVER_LOCATION_HEARTBEAT_MS, type MoverLocationTransition } from '../lib/moverLocation';
import { locationReplyAnswer, parseAcceptance } from '../lib/moverBackgroundRuntime';
import { MOVER_LOCATION_SESSION_MMKV_KEY } from '../lib/moverLocationStorage';
// The API's own answer to an accepted fix. The API suites pin the same literal
// on the wire, so a change on either side fails a test instead of a driver.
import { moverLocationAccepted } from '../../../api/src/contracts/mover-location';

// ---------------------------------------------------------------------------
// LOCATION-BG (14 Oct). A driver went online, the screen said "You're online ·
// LIVE", and about 15 s later the background location task was unregistered:
// no "Swift is sharing your location" notification, and no location at all once
// the app left the screen. The server answered every accepted fix with a bare
// `{ success: true }`; the app read that as "not an answer", and the third such
// answer (the 15 s heartbeat) retired tracking. These tests drive the REAL
// service module — its real task, its real reply adapter, its real start
// options — with only Expo's native layer and the network faked.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const session = {
    generation: 4,
    userId: 'online-driver',
    accessToken: 'online-access',
    refreshToken: 'online-refresh',
  };
  const native = {
    registered: false,
    task: null as null | ((body: { data?: unknown; error?: unknown }) => Promise<void>),
  };
  return {
    session,
    native,
    state: { auth: session as typeof session | null, mmkv: new Map<string, string>() },
    startLocationUpdatesAsync: vi.fn(async () => {
      native.registered = true;
    }),
    stopLocationUpdatesAsync: vi.fn(async () => {
      native.registered = false;
    }),
    hasStartedLocationUpdatesAsync: vi.fn(async () => native.registered),
    driverLocation: vi.fn(),
    riderLocation: vi.fn(),
  };
});

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 'balanced', High: 'high' },
  getForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  getBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  hasStartedLocationUpdatesAsync: mocks.hasStartedLocationUpdatesAsync,
  startLocationUpdatesAsync: mocks.startLocationUpdatesAsync,
  stopLocationUpdatesAsync: mocks.stopLocationUpdatesAsync,
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./api', () => ({
  driverApi: { location: mocks.driverLocation },
  riderApi: { location: mocks.riderLocation },
}));
vi.mock('../lib/queryClient', () => ({
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../lib/storage', () => ({
  initSecureStorage: vi.fn().mockResolvedValue(undefined),
  zustandStorage: {
    getItem: (key: string) => mocks.state.mmkv.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.state.mmkv.set(key, value),
    removeItem: (key: string) => mocks.state.mmkv.delete(key),
  },
}));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => mocks.state.auth,
  useAuthStore: { persist: { rehydrate: vi.fn().mockResolvedValue(undefined) } },
}));

// backgroundLocation.ts loads expo-task-manager with a guarded require so a
// binary without the native module cannot crash at boot. vi.mock does not reach
// a require, so the fake goes into Node's module cache under the package's own
// resolved path; the service then defines its real task against it.
const nodeRequire = createRequire(import.meta.url);
const taskManagerPath = nodeRequire.resolve('expo-task-manager');

const T0 = Date.UTC(2026, 9, 14, 7, 8, 43);
const SPOT = { latitude: 6.80431, longitude: -58.15562 };
const MOVED = { latitude: 6.80791, longitude: -58.15562 }; // ~400 m north

/** The HTTP replies, as the Axios call resolves them (`response.data` is the body). */
const TODAYS_SERVER_ACCEPTS = { data: { success: true } };
const FIXED_SERVER_ACCEPTS = { data: moverLocationAccepted() };

type Service = typeof import('./backgroundLocation');
type Runtime = typeof import('../lib/moverBackgroundRuntime');

async function goOnline() {
  const service: Service = await import('./backgroundLocation');
  const runtime: Runtime = await import('../lib/moverBackgroundRuntime');
  const controller = createMoverLocationController();
  const owner = {};
  const foreground = { onSample: null as null | ((sample: { latitude: number; longitude: number }) => void) };
  const refresh = vi.fn(async () => SPOT);
  const principal = { generation: mocks.session.generation, userId: mocks.session.userId };

  // The dependencies useBroadcastLocation (hooks/mover.ts) hands the shared
  // controller, with the device's watcher and fresh-fix source faked.
  const transition: MoverLocationTransition = {
    kind: 'DRIVER',
    principal,
    isPrincipalCurrent: () => true,
    dependencies: {
      startBackground: (kind, isSessionCurrent) => service.startMoverLocation(kind, () => isSessionCurrent()),
      stopBackground: async () => {
        await service.stopMoverLocation(principal);
      },
      watchForeground: async (onSample) => {
        foreground.onSample = onSample;
        return { remove: () => { foreground.onSample = null; } };
      },
      refreshForegroundSample: refresh,
      commitSharedSample: () => true,
      publish: (kind, sample) => service.publishMoverLocation(kind, sample, mocks.session),
    },
  };
  await controller.transition(owner, transition);

  /** A native fix delivered to the background task, as Expo hands it over. */
  const taskFix = (fix: { latitude: number; longitude: number }, timestamp = Date.now()) => mocks.native.task!({
    data: { locations: [{ coords: { ...fix, accuracy: 18 }, timestamp }] },
  });
  const goOffline = () => controller.transition(owner, null);
  return { service, runtime, foreground, refresh, taskFix, goOffline };
}

/** Logcat order: a cached fix from before GO, the watcher's first fix, a fresh
 *  task fix 8 s later, then the 15 s heartbeat — the third answer. */
async function replayTheFirstFifteenSeconds(online: Awaited<ReturnType<typeof goOnline>>) {
  await online.taskFix(SPOT, T0 - 30_000);
  online.foreground.onSample?.(SPOT);
  await vi.advanceTimersByTimeAsync(8_000);
  await online.taskFix(SPOT);
  await vi.advanceTimersByTimeAsync(MOVER_LOCATION_HEARTBEAT_MS - 8_000 + 500);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ now: T0 });
  mocks.native.registered = false;
  mocks.native.task = null;
  mocks.state.auth = mocks.session;
  mocks.state.mmkv.clear();
  nodeRequire.cache[taskManagerPath] = {
    id: taskManagerPath,
    filename: taskManagerPath,
    loaded: true,
    exports: {
      defineTask: (_name: string, task: (body: { data?: unknown; error?: unknown }) => Promise<void>) => {
        mocks.native.task = task;
      },
    },
  } as unknown as NodeJS.Module;
});

afterEach(() => {
  delete nodeRequire.cache[taskManagerPath];
  vi.useRealTimers();
});

describe('[LOCATION-BG] an online driver keeps sharing location past the first 15 s', () => {
  it.each([
    ['the server as it answers today: a bare { success: true }', TODAYS_SERVER_ACCEPTS],
    ['the server with this fix: an explicit data.accepted = true', FIXED_SERVER_ACCEPTS],
  ])('%s — the task stays registered, the notification stays, and fixes keep reaching the server', async (_label, reply) => {
    mocks.driverLocation.mockResolvedValue(reply);
    const online = await goOnline();

    // GO registered the real task with the visible foreground-service notice.
    expect(mocks.native.task).toBeTypeOf('function');
    expect(mocks.startLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(mocks.startLocationUpdatesAsync).toHaveBeenCalledWith('swift-mover-location', expect.objectContaining({
      accuracy: 'balanced',
      foregroundService: {
        notificationTitle: 'Swift is sharing your location',
        notificationBody: 'Customers can see you on the way. Go offline to stop.',
      },
    }));
    expect(mocks.native.registered).toBe(true);

    await replayTheFirstFifteenSeconds(online);
    expect(mocks.driverLocation.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Two more minutes online: the task delivers a fix every 8 s, the heartbeat every 15 s.
    for (let second = 0; second < 120; second += 8) {
      await vi.advanceTimersByTimeAsync(8_000);
      await online.taskFix(SPOT);
    }
    expect(mocks.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(mocks.native.registered).toBe(true);
    expect(mocks.state.mmkv.get(MOVER_LOCATION_SESSION_MMKV_KEY)).toBeTruthy();

    // The session is still the publisher: a moved fix from the task reaches the
    // server (past the 2 s spacing between movement fixes).
    await vi.advanceTimersByTimeAsync(2_500);
    const before = mocks.driverLocation.mock.calls.length;
    await online.taskFix(MOVED);
    expect(mocks.driverLocation.mock.calls.length).toBe(before + 1);
    expect(mocks.driverLocation).toHaveBeenLastCalledWith(MOVED.latitude, MOVED.longitude, mocks.session, { accuracy: 18 });
    // ...and a parked driver's fix is re-sent at least every 15 s, so the 90 s dispatch window never lapses.
    expect(mocks.driverLocation.mock.calls.length).toBeGreaterThanOrEqual(1 + Math.floor(135_000 / MOVER_LOCATION_HEARTBEAT_MS));
    expect(online.runtime.moverTrackingCounters().publication).not.toHaveProperty('MALFORMED_RESPONSE');
  });

  it('GO OFFLINE stops the task, removes the notification with it, and nothing more is sent', async () => {
    mocks.driverLocation.mockResolvedValue(FIXED_SERVER_ACCEPTS);
    const online = await goOnline();
    await replayTheFirstFifteenSeconds(online);
    expect(mocks.native.registered).toBe(true);
    expect(mocks.stopLocationUpdatesAsync).not.toHaveBeenCalled();

    await online.goOffline();

    expect(mocks.stopLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(mocks.stopLocationUpdatesAsync).toHaveBeenCalledWith('swift-mover-location');
    expect(mocks.native.registered).toBe(false);
    expect(mocks.state.mmkv.has(MOVER_LOCATION_SESSION_MMKV_KEY)).toBe(false);

    const sent = mocks.driverLocation.mock.calls.length;
    const refreshed = online.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4 * MOVER_LOCATION_HEARTBEAT_MS);
    await online.taskFix(MOVED); // a queued native event after GO OFFLINE
    expect(online.refresh.mock.calls.length).toBe(refreshed);
    expect(mocks.driverLocation.mock.calls.length).toBe(sent);
    await expect(online.service.publishMoverLocation('DRIVER', MOVED, mocks.session)).resolves.toEqual({ published: false });
  });

  it('a refusal still stops tracking at once, and the server\'s reason is kept', async () => {
    mocks.driverLocation.mockResolvedValue({ data: { success: true, data: { accepted: false, reason: 'SESSION_REPLACED' } } });
    const online = await goOnline();
    online.foreground.onSample?.(SPOT);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.driverLocation).toHaveBeenCalledOnce();
    expect(mocks.stopLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(mocks.native.registered).toBe(false);
    expect(online.runtime.moverTrackingCounters().publication).toEqual({ SESSION_REPLACED: 1 });
  });

  it('a reply that is not the contract still never checkpoints, and three of them stop tracking', async () => {
    for (const body of ['<html>captive portal</html>', {}, { success: false }]) {
      mocks.driverLocation.mockResolvedValueOnce({ data: body });
    }
    const online = await goOnline();
    for (let i = 0; i < 3; i += 1) {
      await online.taskFix(SPOT);
      if (i < 2) expect(mocks.native.registered).toBe(true);
    }

    expect(mocks.driverLocation).toHaveBeenCalledTimes(3);
    expect(mocks.stopLocationUpdatesAsync).toHaveBeenCalledOnce();
    expect(mocks.native.registered).toBe(false);
    expect(online.runtime.moverTrackingCounters().publication).toEqual({ MALFORMED_RESPONSE: 3 });
  });
});

describe('[LOCATION-BG] the reply adapter reads the server\'s real envelopes', () => {
  it('both accepted envelopes accept, a refusal keeps its reason, and nothing else is an answer', () => {
    const read = (body: unknown) => parseAcceptance(locationReplyAnswer(body));
    expect(moverLocationAccepted()).toEqual({ success: true, data: { accepted: true } });
    expect(read(moverLocationAccepted())).toEqual({ kind: 'accepted' });
    expect(read({ success: true })).toEqual({ kind: 'accepted' });
    expect(read({ success: true, data: { accepted: false, reason: 'OFFLINE' } })).toEqual({ kind: 'refused', reason: 'OFFLINE' });
    for (const bad of [
      undefined, null, '', '<html>captive portal</html>', [], {}, { success: false }, { success: 'true' },
      { data: { accepted: true } }, { success: true, data: null }, { success: true, data: {} },
      { success: true, data: { accepted: 'true' } },
    ]) {
      expect(read(bad), JSON.stringify(bad)).toEqual({ kind: 'malformed' });
    }
  });
});
