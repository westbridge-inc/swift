import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { riderApi, driverApi } from './api';
import {
  requestUsableMoverBackgroundPermission,
  type MoverKind,
} from '../lib/moverLocation';
import { queryClient } from '../lib/queryClient';
import { initSecureStorage, zustandStorage } from '../lib/storage';
import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import type { AuthPrincipalBoundary, AuthSessionSnapshot } from '../lib/authSession';
import { createMoverBackgroundLocationRuntime } from '../lib/moverBackgroundRuntime';
import {
  createMoverLocationDurableStorage,
  MOVER_LOCATION_LEGACY_SECURE_STORE_KEY,
} from '../lib/moverLocationStorage';

// expo-task-manager is a NATIVE module: importing it runs requireNativeModule
// at bundle-eval time, which THROWS on a binary built before this dependency
// was added — crashing the whole app at startup, not just disabling background
// GPS. Load it defensively so a missing native module degrades to "no
// background task" (the caller falls back to the foreground watcher). The
// background stream lights up on the next native build.
let TaskManager: typeof import('expo-task-manager') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  TaskManager = require('expo-task-manager');
} catch {
  TaskManager = null;
}

// H9 (pre-launch audit): the driver's GPS was foreground-only, so the customer's
// live marker froze the instant the driver opened Maps/WhatsApp or locked the
// screen. This streams location from a background task while the mover is
// online. The app.config already declares the iOS `location` background mode +
// Android background/foreground-service location, so this activates on the next
// native build; until then (and if background permission is denied) the caller
// falls back to the foreground watcher — no regression.

export const MOVER_LOCATION_TASK = 'swift-mover-location';
const locationStorage = createMoverLocationDurableStorage({
  initialize: initSecureStorage,
  getValue: (key) => zustandStorage.getItem(key),
  setValue: (key, value) => zustandStorage.setItem(key, value),
  removeValue: (key) => zustandStorage.removeItem(key),
  readLegacy: () => SecureStore.getItemAsync(MOVER_LOCATION_LEGACY_SECURE_STORE_KEY),
  deleteLegacy: () => SecureStore.deleteItemAsync(MOVER_LOCATION_LEGACY_SECURE_STORE_KEY),
});

const runtime = createMoverBackgroundLocationRuntime({
  now: Date.now,
  getAuthSession: getAuthSessionSnapshot,
  initializeAuthStorage: initSecureStorage,
  rehydrateAuth: async () => {
    await useAuthStore.persist.rehydrate();
  },
  readPersistedSession: locationStorage.read,
  writePersistedSession: locationStorage.write,
  deletePersistedSession: locationStorage.delete,
  hasForegroundPermission: async () => (
    (await Location.getForegroundPermissionsAsync()).status === 'granted'
  ),
  hasBackgroundPermission: async () => (
    (await Location.getBackgroundPermissionsAsync()).status === 'granted'
  ),
  isNativeRunning: () => Location.hasStartedLocationUpdatesAsync(MOVER_LOCATION_TASK),
  startNative: () => Location.startLocationUpdatesAsync(MOVER_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    // iOS distance filters do not emit a dependable stationary heartbeat.
    // Keep native fixes flowing; the runtime authority-checks and throttles.
    distanceInterval: 0,
    timeInterval: 8000,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Swift is sharing your location',
      notificationBody: 'Customers can see you on the way. Go offline to stop.',
    },
  }),
  stopNative: () => Location.stopLocationUpdatesAsync(MOVER_LOCATION_TASK),
  publish: async (kind, sample, session) => {
    const service = kind === 'DRIVER' ? driverApi : riderApi;
    // [ALG-15] The device's own accuracy and mock signal ride along only when
    // the platform gave them — an old-shaped sample is sent exactly as before.
    const fix = sample.accuracy != null || sample.mocked != null
      ? { ...(sample.accuracy != null ? { accuracy: sample.accuracy } : {}), ...(sample.mocked != null ? { mocked: sample.mocked } : {}) }
      : undefined;
    const response = fix
      ? await service.location(sample.latitude, sample.longitude, session, fix)
      : await service.location(sample.latitude, sample.longitude, session);
    return { accepted: response?.data?.data?.accepted };
  },
  invalidateMoverQueries: () => {
    void queryClient.invalidateQueries({ queryKey: ['mover'] });
  },
});

TaskManager?.defineTask(MOVER_LOCATION_TASK, async ({ data, error }) => {
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  await runtime.handleTask({
    error,
    locations: locations?.map((location) => ({
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      // [ALG-15] What the platform reports, as it reports it — only when it does.
      ...(location.coords.accuracy != null ? { accuracy: location.coords.accuracy } : {}),
      ...((location as { mocked?: boolean }).mocked != null ? { mocked: (location as { mocked?: boolean }).mocked } : {}),
      timestamp: location.timestamp,
    })),
  });
});

/** Start background GPS streaming for an online mover. Returns true only if
 *  background updates actually started; false means the caller should use the
 *  foreground watcher instead. Never throws. */
export function startMoverLocation(
  kind: MoverKind,
  isAuthorized: () => boolean,
): Promise<boolean> {
  return runtime.start(kind, isAuthorized, TaskManager !== null);
}

/** Foreground and TaskManager fixes converge on the same principal-bound,
 * distance-aware durable publication gate. */
export function publishMoverLocation(
  kind: MoverKind,
  sample: { latitude: number; longitude: number; accuracy?: number | null; mocked?: boolean | null },
  session: AuthSessionSnapshot,
) {
  return runtime.publishForeground(kind, sample, session);
}

/** Explicit GO-only background upgrade. Restored online sessions never call
 * this function; they silently use an existing grant or foreground fallback.
 *
 * `disclose` shows the Play-mandated prominent disclosure and resolves to what
 * the person chose. It is a parameter rather than an import because this module
 * is service-layer and must not reach up into a screen — and because a test can
 * then prove the OS prompt is never raised on a decline. */
export async function requestMoverBackgroundPermission(
  disclose: () => Promise<boolean>,
): Promise<boolean> {
  return requestUsableMoverBackgroundPermission({
    taskManagerAvailable: TaskManager !== null,
    getForegroundPermission: Location.getForegroundPermissionsAsync,
    getBackgroundPermission: Location.getBackgroundPermissionsAsync,
    requestBackgroundPermission: Location.requestBackgroundPermissionsAsync,
    disclose,
  });
}

export function stopMoverLocation(expectedOwner?: AuthPrincipalBoundary): Promise<boolean> {
  return runtime.stop(expectedOwner);
}
