import * as Location from 'expo-location';
import { riderApi, driverApi } from './api';
import type { MoverKind } from '../hooks/mover';

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

// The task runs in a headless JS context with no React — read the kind from a
// module singleton set when we start (same runtime, so this survives
// backgrounding).
let activeKind: MoverKind | null = null;

TaskManager?.defineTask(MOVER_LOCATION_TASK, async ({ data, error }) => {
  if (error || !activeKind) return;
  const locations = (data as { locations?: Location.LocationObject[] })?.locations ?? [];
  const last = locations[locations.length - 1];
  if (!last) return;
  const svc = activeKind === 'DRIVER' ? driverApi : riderApi;
  // Best-effort: a failed send just means one skipped marker update.
  await svc.location(last.coords.latitude, last.coords.longitude).catch(() => {});
});

/** Start background GPS streaming for an online mover. Returns true only if
 *  background updates actually started; false means the caller should use the
 *  foreground watcher instead. Never throws. */
export async function startMoverLocation(kind: MoverKind): Promise<boolean> {
  if (!TaskManager) return false; // native module absent — use foreground watch
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return false;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return false; // fall back to foreground watch

    activeKind = kind;
    const already = await Location.hasStartedLocationUpdatesAsync(MOVER_LOCATION_TASK).catch(() => false);
    if (already) return true;

    await Location.startLocationUpdatesAsync(MOVER_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 25, // metres — a parked mover doesn't spam
      timeInterval: 8000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Swift is sharing your location',
        notificationBody: 'Customers can see you on the way. Go offline to stop.',
      },
    });
    return true;
  } catch {
    // expo-task-manager not in this native build yet, or a runtime error —
    // caller uses the foreground watcher. No regression vs before.
    activeKind = null;
    return false;
  }
}

export async function stopMoverLocation(): Promise<void> {
  activeKind = null;
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(MOVER_LOCATION_TASK).catch(() => false);
    if (running) await Location.stopLocationUpdatesAsync(MOVER_LOCATION_TASK);
  } catch {
    // nothing to stop
  }
}
