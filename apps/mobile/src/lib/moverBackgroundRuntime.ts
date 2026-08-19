import {
  authSessionForPrincipal,
  samePrincipalBoundary,
  type AuthPrincipalBoundary,
  type AuthSessionSnapshot,
} from './authSession';
import {
  decodeMoverLocationSession,
  encodeMoverLocationSession,
  type DurableMoverLocationSession,
} from './moverBackgroundSession';
import {
  canTeardownRuntime,
  SerializedRuntimeLifecycle,
} from './runtimeOwnership';
import {
  MOVER_LOCATION_HEARTBEAT_MS,
  type MoverKind,
} from './moverLocation';

export interface BackgroundLocationSample {
  latitude: number;
  longitude: number;
  timestamp: number;
}

export interface BackgroundLocationTaskEvent {
  error?: unknown;
  locations?: BackgroundLocationSample[];
}

export interface MoverLocationPublicationOutcome {
  published: boolean;
  accepted?: boolean;
}

export interface MoverBackgroundRuntimeDependencies {
  now: () => number;
  getAuthSession: () => AuthSessionSnapshot | null;
  initializeAuthStorage: () => Promise<void>;
  rehydrateAuth: () => Promise<unknown>;
  readPersistedSession: () => Promise<string | null>;
  writePersistedSession: (raw: string) => Promise<void>;
  deletePersistedSession: () => Promise<void>;
  hasForegroundPermission: () => Promise<boolean>;
  hasBackgroundPermission: () => Promise<boolean>;
  isNativeRunning: () => Promise<boolean>;
  startNative: () => Promise<void>;
  stopNative: () => Promise<void>;
  publish: (
    kind: MoverKind,
    sample: Pick<BackgroundLocationSample, 'latitude' | 'longitude'>,
    session: AuthSessionSnapshot,
  ) => Promise<{ accepted?: boolean } | null | undefined>;
  invalidateMoverQueries: () => void;
}

interface ActiveMoverLocationSession {
  kind: MoverKind;
  owner: AuthPrincipalBoundary;
  isLocallyAuthorized: () => boolean;
  startedAt: number;
  lastPublishedAt?: number;
  lastLatitude?: number;
  lastLongitude?: number;
  publishing: boolean;
}

type RestoreOutcome =
  | { status: 'restored'; session: ActiveMoverLocationSession }
  | { status: 'cleanup-pending' }
  | { status: 'absent' }
  | { status: 'unreadable' };

/** Movement is published promptly but noisy duplicate fixes are collapsed.
 * Native/foreground sources both use this one policy. */
export const MIN_MOVING_LOCATION_INTERVAL_MS = 2_000;
export const MEANINGFUL_LOCATION_MOVEMENT_METERS = 10;
export const MAX_LOCATION_SILENCE_MS = MOVER_LOCATION_HEARTBEAT_MS;

/** Durable exponential backoff prevents a broken native unregister from cold-
 * launching JS on every GPS event forever while preserving future retries. */
export const LOCATION_CLEANUP_BASE_BACKOFF_MS = 2_000;
export const LOCATION_CLEANUP_MAX_BACKOFF_MS = 5 * 60_000;

function cleanupBackoff(attempt: number): number {
  return Math.min(
    LOCATION_CLEANUP_BASE_BACKOFF_MS * (2 ** Math.min(Math.max(attempt - 1, 0), 8)),
    LOCATION_CLEANUP_MAX_BACKOFF_MS,
  );
}

function distanceMeters(
  left: Pick<BackgroundLocationSample, 'latitude' | 'longitude'>,
  right: Pick<BackgroundLocationSample, 'latitude' | 'longitude'>,
): number {
  const radians = (degrees: number) => degrees * (Math.PI / 180);
  const latDelta = radians(right.latitude - left.latitude);
  const lngDelta = radians(right.longitude - left.longitude);
  const leftLat = radians(left.latitude);
  const rightLat = radians(right.latitude);
  const haversine = Math.sin(latDelta / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(lngDelta / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, haversine));
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

export function createMoverBackgroundLocationRuntime(
  dependencies: MoverBackgroundRuntimeDependencies,
) {
  let activeSession: ActiveMoverLocationSession | null = null;
  const lifecycle = new SerializedRuntimeLifecycle();

  const runLifecycle = <T>(operation: () => Promise<T>) => lifecycle.run(operation);

  const currentAuthorizedSession = (
    session: ActiveMoverLocationSession,
  ): AuthSessionSnapshot | null => {
    try {
      const current = dependencies.getAuthSession();
      return session.isLocallyAuthorized()
        ? authSessionForPrincipal(current, session.owner)
        : null;
    } catch {
      return null;
    }
  };

  const durableForSession = (
    session: ActiveMoverLocationSession,
  ): DurableMoverLocationSession => ({
    kind: session.kind,
    startedAt: session.startedAt,
    userId: session.owner.userId,
    ...(session.lastPublishedAt !== undefined
      && session.lastLatitude !== undefined
      && session.lastLongitude !== undefined
      ? {
        lastPublishedAt: session.lastPublishedAt,
        lastLatitude: session.lastLatitude,
        lastLongitude: session.lastLongitude,
      }
      : {}),
  });

  const persistDurableSession = (session: DurableMoverLocationSession) => (
    dependencies.writePersistedSession(encodeMoverLocationSession(session))
  );

  /** A failed probe is unknown—not "stopped". Attempt unregister anyway, but
   * retain the tombstone for one later affirmative probe before reporting
   * cleanup complete. */
  const unregisterNative = async (): Promise<boolean> => {
    let probeKnown = true;
    let running: boolean;
    try {
      running = await dependencies.isNativeRunning();
    } catch {
      probeKnown = false;
      running = true;
    }
    if (running) {
      try {
        await dependencies.stopNative();
      } catch {
        return false;
      }
    }
    return probeKnown;
  };

  const attemptDurableCleanup = async (
    durable: DurableMoverLocationSession,
  ): Promise<boolean> => {
    const attempt = (durable.cleanupAttempts ?? 0) + 1;
    const tombstone: DurableMoverLocationSession = {
      ...durable,
      cleanupPending: true,
      cleanupAttempts: attempt,
      nextCleanupAttemptAt: dependencies.now() + cleanupBackoff(attempt),
    };
    let tombstoneWritten = false;
    try {
      await persistDurableSession(tombstone);
      tombstoneWritten = true;
    } catch {
      // Still attempt native unregister. The false result exposes that durable
      // fail-closed state could not be confirmed unless delete also succeeds.
    }

    const nativeStopped = await unregisterNative();
    if (!nativeStopped) {
      // If the tombstone could not be recorded, remove the old publishable
      // authority record. A surviving native task then cold-launches with no
      // authority and retries unregister instead of resurrecting this session.
      if (!tombstoneWritten) await dependencies.deletePersistedSession().catch(() => {});
      return false;
    }
    try {
      await dependencies.deletePersistedSession();
      return true;
    } catch {
      return false;
    }
  };

  /** Must execute inside runLifecycle. */
  const retireCurrentSession = async (
    session: ActiveMoverLocationSession,
  ): Promise<boolean> => {
    if (activeSession !== session) return false;
    activeSession = null;
    return attemptDurableCleanup(durableForSession(session));
  };

  const retireSessionIfCurrent = (session: ActiveMoverLocationSession) => (
    runLifecycle(() => retireCurrentSession(session))
  );

  const cleanupUnknownAuthority = () => runLifecycle(async () => {
    if (activeSession) return false;
    return unregisterNative();
  });

  const restoreHeadlessSession = (): Promise<RestoreOutcome> => runLifecycle(async () => {
    if (activeSession) return { status: 'restored', session: activeSession };

    let raw: string | null;
    try {
      raw = await dependencies.readPersistedSession();
    } catch {
      // Authority cannot be proven in this cold launch. Fail closed on the
      // first event; an in-memory retry counter would reset on every launch.
      return { status: 'unreadable' };
    }

    const durable = decodeMoverLocationSession(raw);
    if (!durable) {
      if (raw) {
        try {
          await dependencies.deletePersistedSession();
        } catch {
          return { status: 'unreadable' };
        }
      }
      return { status: 'absent' };
    }

    if (durable.cleanupPending) {
      if (dependencies.now() >= durable.nextCleanupAttemptAt!) {
        await attemptDurableCleanup(durable);
      }
      return { status: 'cleanup-pending' };
    }

    let auth = dependencies.getAuthSession();
    if (!auth) {
      try {
        await dependencies.initializeAuthStorage();
        // Interactive login may have completed while encrypted storage opened.
        auth = dependencies.getAuthSession();
        if (!auth) {
          await dependencies.rehydrateAuth();
          auth = dependencies.getAuthSession();
        }
      } catch {
        return { status: 'unreadable' };
      }
    }

    if (!auth || auth.userId !== durable.userId) {
      await attemptDurableCleanup(durable);
      return { status: 'cleanup-pending' };
    }

    const restored: ActiveMoverLocationSession = {
      kind: durable.kind,
      startedAt: durable.startedAt,
      owner: { generation: auth.generation, userId: auth.userId },
      isLocallyAuthorized: () => true,
      lastPublishedAt: durable.lastPublishedAt,
      lastLatitude: durable.lastLatitude,
      lastLongitude: durable.lastLongitude,
      publishing: false,
    };
    activeSession = restored;
    return { status: 'restored', session: restored };
  });

  const shouldPublish = (
    session: ActiveMoverLocationSession,
    sample: Pick<BackgroundLocationSample, 'latitude' | 'longitude'>,
    now: number,
  ): boolean => {
    if (
      session.lastPublishedAt === undefined
      || session.lastLatitude === undefined
      || session.lastLongitude === undefined
    ) return true;
    const elapsed = now - session.lastPublishedAt;
    if (elapsed < 0) return false;
    if (elapsed >= MAX_LOCATION_SILENCE_MS) return true;
    if (elapsed < MIN_MOVING_LOCATION_INTERVAL_MS) return false;
    return distanceMeters(
      { latitude: session.lastLatitude, longitude: session.lastLongitude },
      sample,
    ) >= MEANINGFUL_LOCATION_MOVEMENT_METERS;
  };

  /** The only API publication path for both foreground and TaskManager fixes. */
  const publishSample = async (
    session: ActiveMoverLocationSession,
    sample: Pick<BackgroundLocationSample, 'latitude' | 'longitude'>,
    authSession: AuthSessionSnapshot,
  ): Promise<MoverLocationPublicationOutcome> => {
    if (
      activeSession !== session
      || !samePrincipalBoundary(authSession, session.owner)
      || !currentAuthorizedSession(session)
      || !Number.isFinite(sample.latitude)
      || !Number.isFinite(sample.longitude)
      || session.publishing
    ) return { published: false };

    const publishedAt = dependencies.now();
    if (!shouldPublish(session, sample, publishedAt)) return { published: false };

    session.publishing = true;
    try {
      const response = await dependencies.publish(session.kind, sample, authSession);
      if (response?.accepted === false) {
        await retireSessionIfCurrent(session);
        dependencies.invalidateMoverQueries();
        return { published: true, accepted: false };
      }
      if (activeSession === session && currentAuthorizedSession(session)) {
        session.lastPublishedAt = publishedAt;
        session.lastLatitude = sample.latitude;
        session.lastLongitude = sample.longitude;
        // Publication state is part of the authority record so a one-event JS
        // cold launch cannot reset the movement/heartbeat gate.
        try {
          await persistDurableSession(durableForSession(session));
        } catch {
          // Continuing native events without a durable checkpoint would reset
          // the gate on every cold launch and create an unbounded write/API
          // loop. Retire fail-closed; foreground GO can reacquire after storage
          // recovers.
          await retireSessionIfCurrent(session);
        }
      } else {
        await retireSessionIfCurrent(session);
      }
      return { published: true, accepted: response?.accepted };
    } catch {
      if (!currentAuthorizedSession(session)) {
        await retireSessionIfCurrent(session);
      }
      return { published: true };
    } finally {
      session.publishing = false;
    }
  };

  const handleTask = async (event: BackgroundLocationTaskEvent): Promise<void> => {
    if (event.error) return;

    let session = activeSession;
    if (!session) {
      const restored = await restoreHeadlessSession();
      if (restored.status === 'unreadable' || restored.status === 'absent') {
        await cleanupUnknownAuthority();
        return;
      }
      if (restored.status === 'cleanup-pending') {
        return;
      }
      session = restored.session;
    }

    const authSession = currentAuthorizedSession(session);
    if (!authSession) {
      await retireSessionIfCurrent(session);
      return;
    }

    const last = event.locations?.[event.locations.length - 1];
    if (!last) return;
    if (!Number.isFinite(last.timestamp) || last.timestamp < session.startedAt) return;
    if (!Number.isFinite(last.latitude) || !Number.isFinite(last.longitude)) return;
    await publishSample(
      session,
      { latitude: last.latitude, longitude: last.longitude },
      authSession,
    );
  };

  const start = (
    kind: MoverKind,
    isAuthorized: () => boolean,
    nativeAvailable = true,
  ): Promise<boolean> => runLifecycle(async () => {
    let installed: ActiveMoverLocationSession | null = null;
    try {
      const auth = dependencies.getAuthSession();
      if (!auth || !isAuthorized()) return false;
      const owner = { generation: auth.generation, userId: auth.userId };
      const startedAt = dependencies.now();
      const session: ActiveMoverLocationSession = {
        kind,
        owner,
        isLocallyAuthorized: isAuthorized,
        startedAt,
        publishing: false,
      };
      activeSession = session;
      installed = session;

      try {
        await dependencies.writePersistedSession(encodeMoverLocationSession({
          kind,
          startedAt,
          userId: owner.userId,
        }));
      } catch {
        await retireCurrentSession(session);
        return false;
      }
      if (!currentAuthorizedSession(session)) {
        await retireCurrentSession(session);
        return false;
      }
      // Even without TaskManager/background permission, retain this authority-
      // bound publication session so foreground movement uses the same gate.
      if (!nativeAvailable) return false;
      if (!await dependencies.hasForegroundPermission()) return false;
      if (!await dependencies.hasBackgroundPermission()) return false;
      if (!currentAuthorizedSession(session)) {
        await retireCurrentSession(session);
        return false;
      }
      const already = await dependencies.isNativeRunning().catch(() => false);
      if (!currentAuthorizedSession(session)) {
        await retireCurrentSession(session);
        return false;
      }
      if (!already) await dependencies.startNative();
      if (!currentAuthorizedSession(session)) {
        await retireCurrentSession(session);
        return false;
      }
      return true;
    } catch {
      if (installed) await retireCurrentSession(installed);
      return false;
    }
  });

  const publishForeground = (
    kind: MoverKind,
    sample: Pick<BackgroundLocationSample, 'latitude' | 'longitude'>,
    authSession: AuthSessionSnapshot,
  ): Promise<MoverLocationPublicationOutcome> => {
    const session = activeSession;
    if (!session || session.kind !== kind) return Promise.resolve({ published: false });
    return publishSample(session, sample, authSession);
  };

  const stop = (expectedOwner?: AuthPrincipalBoundary): Promise<boolean> => runLifecycle(async () => {
    const session = activeSession;
    if (session) {
      if (!canTeardownRuntime(session.owner, expectedOwner)) return true;
      return retireCurrentSession(session);
    }

    let raw: string | null;
    try {
      raw = await dependencies.readPersistedSession();
    } catch {
      const nativeStopped = await unregisterNative();
      let durableDeleted = true;
      try {
        await dependencies.deletePersistedSession();
      } catch {
        durableDeleted = false;
      }
      return nativeStopped && durableDeleted;
    }
    const durable = decodeMoverLocationSession(raw);
    if (expectedOwner && durable && durable.userId !== expectedOwner.userId) return true;
    if (durable) return attemptDurableCleanup(durable);

    const nativeStopped = await unregisterNative();
    if (!nativeStopped) return false;
    if (!raw) return true;
    try {
      await dependencies.deletePersistedSession();
      return true;
    } catch {
      return false;
    }
  });

  return { handleTask, publishForeground, start, stop };
}
