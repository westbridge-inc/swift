import type { DeviceLocationResolution } from './deviceLocation';
import type { AuthPrincipalBoundary } from './authSession';

export type MoverKind = 'DRIVER' | 'RIDER';

export interface MoverLocationSample {
  latitude: number;
  longitude: number;
}

export interface MoverLocationSubscription {
  remove: () => void;
}

export interface MoverLocationSession {
  background: boolean;
  subscription?: MoverLocationSubscription;
  heartbeat?: ReturnType<typeof setInterval>;
}

export interface MoverLocationSessionDependencies {
  startBackground: (
    kind: MoverKind,
    isSessionCurrent: () => boolean,
  ) => Promise<boolean>;
  stopBackground: () => Promise<void>;
  watchForeground: (
    onSample: (sample: MoverLocationSample) => void,
  ) => Promise<MoverLocationSubscription>;
  /** Obtain a fresh OS-authoritative fix for the stationary heartbeat. */
  refreshForegroundSample: () => Promise<MoverLocationSample>;
  commitSharedSample: (sample: MoverLocationSample) => boolean;
  publish: (kind: MoverKind, sample: MoverLocationSample) => Promise<unknown> | unknown;
}

function commitMoverSample(
  kind: MoverKind,
  sample: MoverLocationSample,
  dependencies: MoverLocationSessionDependencies,
  publishForeground: boolean,
  isSessionCurrent: () => boolean,
) {
  if (
    !isSessionCurrent()
    || !Number.isFinite(sample.latitude)
    || !Number.isFinite(sample.longitude)
  ) return;

  // The shared store powers the mover map, demand, ETA and SOS. Publishing
  // only to the API would leave those surfaces stale until an unrelated
  // AppState transition happened.
  const accepted = dependencies.commitSharedSample(sample);
  if (!accepted) return;

  // Authentication can change synchronously from commitSharedSample (or from
  // another React store subscriber). Re-check at the final network boundary;
  // the publisher also carries the captured credentials rather than looking
  // up whichever account happens to be current on the Axios microtask.
  if (publishForeground && isSessionCurrent()) {
    try {
      void Promise.resolve(dependencies.publish(kind, sample)).catch(() => {});
    } catch {
      // A skipped network update is non-fatal; the next GPS sample retries.
    }
  }
}

/** Keep a parked, foreground mover's server lease alive without waiting for
 * Core Location to cross the distance filter. Every renewal obtains a fresh
 * OS fix; replaying an old sample would advertise ghost supply forever if the
 * watcher stalls or Location Services is disabled. */
export const MOVER_LOCATION_HEARTBEAT_MS = 15_000;

/** Keep trip tracking alive even when safety/compliance revoked new-job supply.
 * An active assignment remains location-authorized on the server so customers
 * and operations do not lose the live trip after a restart. */
export function shouldTrackMoverLocation(isOnline: boolean, activeJob: unknown): boolean {
  return isOnline || activeJob != null;
}

/**
 * Starts one mover stream after an explicit foreground grant has been accepted
 * by the shared device-location state machine. Cancellation is checked after
 * every async boundary so an online/offline race cannot leak a watcher or
 * background task.
 */
export async function startMoverLocationSession(
  kind: MoverKind,
  dependencies: MoverLocationSessionDependencies,
  isCancelled: () => boolean,
): Promise<MoverLocationSession> {
  const background = await dependencies.startBackground(kind, () => !isCancelled());
  if (isCancelled()) {
    await dependencies.stopBackground();
    return { background: false };
  }
  let subscription: MoverLocationSubscription;
  try {
    subscription = await dependencies.watchForeground((sample) => {
      if (isCancelled()) return;
      // Foreground and background samples converge on the service-level
      // distance/time gate. Suppressing this path when native background is
      // active made a fast mover appear frozen until the old global heartbeat.
      commitMoverSample(kind, sample, dependencies, true, () => !isCancelled());
    });
  } catch (error) {
    await dependencies.stopBackground();
    throw error;
  }

  if (isCancelled()) {
    subscription.remove();
    await dependencies.stopBackground();
    return { background: false };
  }

  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (isCancelled() || heartbeatInFlight) return;
    heartbeatInFlight = true;
    void dependencies.refreshForegroundSample()
      .then((sample) => {
        if (!isCancelled()) {
          commitMoverSample(kind, sample, dependencies, true, () => !isCancelled());
        }
      })
      .catch(() => {
        // No fresh native authority means no lease renewal. The server's
        // freshness cutoff removes this mover from candidate supply.
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, MOVER_LOCATION_HEARTBEAT_MS);
  // Node test runners otherwise keep the process alive; React Native timers are
  // numeric and simply skip this branch.
  if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();

  return { background, subscription, heartbeat };
}

interface ActiveMoverLocationSession {
  session: MoverLocationSession;
  stopBackground: () => Promise<void>;
}

export interface MoverLocationTransition {
  kind: MoverKind;
  /** The login boundary that acquired this native stream. Token rotations stay
   * within it; logout/login and shared-device account changes do not. */
  principal: AuthPrincipalBoundary;
  isPrincipalCurrent: (expected: AuthPrincipalBoundary) => boolean;
  dependencies: MoverLocationSessionDependencies;
}

/**
 * Serializes the native mover-location lifecycle across React effect cleanup
 * and replacement. A stop is always allowed to finish before a later start,
 * and the revision check makes callbacks from superseded sessions inert as
 * soon as a new transition is requested.
 */
export function createMoverLocationController() {
  let revision = 0;
  let tail: Promise<void> = Promise.resolve();
  let active: ActiveMoverLocationSession | null = null;
  let desiredOwner: object | null = null;

  const stopActive = async () => {
    const owned = active;
    active = null;
    if (!owned) return;
    if (owned.session.heartbeat) clearInterval(owned.session.heartbeat);
    try {
      owned.session.subscription?.remove();
    } catch {
      // A native subscription may already have removed itself.
    }
    try {
      await owned.stopBackground();
    } catch {
      // A best-effort native stop must not strand the serialized queue.
    }
  };

  return {
    transition(owner: object, next: MoverLocationTransition | null) {
      // A late cleanup from a screen that no longer owns the global native
      // task must not stop the newer screen's stream.
      if (!next && desiredOwner !== owner) return Promise.resolve();
      desiredOwner = next ? owner : null;
      const requestedRevision = ++revision;
      const isRequestCurrent = () => (
        requestedRevision === revision
        && !!next
        && next.isPrincipalCurrent(next.principal)
      );
      const run = async () => {
        // Even a now-superseded stop transition must release the prior owner
        // before the replacement transition is allowed to start.
        await stopActive();
        if (!next || !isRequestCurrent()) return;

        try {
          const session = await startMoverLocationSession(
            next.kind,
            next.dependencies,
            () => !isRequestCurrent(),
          );

          if (!isRequestCurrent()) {
            // The session helper normally observes cancellation at its final
            // boundary; retain this defensive cleanup if an implementation
            // ever resolves between that check and ownership transfer.
            try {
              session.subscription?.remove();
            } catch {
              // already removed
            }
            if (session.heartbeat) clearInterval(session.heartbeat);
            try {
              await next.dependencies.stopBackground();
            } catch {
              // best effort
            }
            return;
          }

          active = { session, stopBackground: next.dependencies.stopBackground };
        } catch {
          // Location startup is non-fatal. GO remains valid with the server
          // gate intact, and a later transition retries the stream.
        }
      };

      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
  };
}

// Expo owns one module-global background task. Every hook instance therefore
// shares one owner-aware controller rather than maintaining a per-screen queue.
export const sharedMoverLocationController = createMoverLocationController();

export async function requestUsableMoverBackgroundPermission({
  taskManagerAvailable,
  getForegroundPermission,
  requestBackgroundPermission,
}: {
  taskManagerAvailable: boolean;
  getForegroundPermission: () => Promise<{ status: string }>;
  requestBackgroundPermission: () => Promise<{ status: string }>;
}) {
  // Never ask for background access when this installed binary cannot execute
  // the background task that would use it.
  if (!taskManagerAvailable) return false;
  try {
    const foreground = await getForegroundPermission();
    if (foreground.status !== 'granted') return false;
    const background = await requestBackgroundPermission();
    return background.status === 'granted';
  } catch {
    return false;
  }
}

export async function prepareMoverOnline({
  resolveForeground,
  requestBackground,
  getForegroundFix,
  goOnline,
}: {
  resolveForeground: () => Promise<DeviceLocationResolution>;
  requestBackground: () => Promise<boolean>;
  getForegroundFix: () => { latitude: number; longitude: number } | null;
  goOnline: (location: { latitude: number; longitude: number }) => Promise<unknown>;
}) {
  const resolution = await resolveForeground();
  if (resolution.status !== 'granted') return resolution;
  if (!getForegroundFix()) return { status: 'unavailable' } as const;

  // Background access is an enhancement. A denial still permits the explicit
  // GO action with the foreground watcher active while Swift is visible.
  try {
    await requestBackground();
  } catch {
    // fall through to foreground-only online mode
  }
  // The background permission sheet can trigger AppState work or the user can
  // revoke access in Settings. Never tell the server this mover is online
  // unless the canonical coordinator still owns a current foreground grant.
  const authoritativeFix = getForegroundFix();
  if (!authoritativeFix) return { status: 'unavailable' } as const;
  await goOnline(authoritativeFix);
  return resolution;
}
