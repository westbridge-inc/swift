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
  /** [ALG-15] Passed through from the platform when present, never invented. */
  accuracy?: number | null;
  mocked?: boolean | null;
  timestamp: number;
}

export interface BackgroundLocationTaskEvent {
  error?: unknown;
  locations?: BackgroundLocationSample[];
}

export interface MoverLocationPublicationOutcome {
  published: boolean;
  accepted?: boolean;
  /** [MOB-017] Why this sample was or was not published/accepted — a policy verdict, a server reason, or the response's shape. */
  reason?: string;
}

/** A sample as the runtime publishes it: coordinates AND the device's own quality evidence, never stripped. */
export type PublishableSample = Pick<BackgroundLocationSample, 'latitude' | 'longitude' | 'accuracy' | 'mocked'> & { timestamp?: number };

// ---------------------------------------------------------------------------
// [MOB-017] The sample policy and the acceptance schema.
//
// Quality evidence (timestamp, accuracy, mock flag) used to be dropped between
// the native event and the publish call, a malformed server response counted
// as an accepted checkpoint, and a durable record restored on user id alone.
// Now: a sample is published only when it is in range, fresh, not from the
// future, not before this session began and not hopelessly inaccurate; a mock
// fix is published WITH its flag (the server's plausibility check wants the
// evidence, hiding it would delete it); only a schema-valid `accepted: true`
// checkpoints; a refusal retires; a malformed response never checkpoints and,
// repeated, retires fail-closed.
// ---------------------------------------------------------------------------

/** A fix older than this is history, not a position. */
export const MAX_SAMPLE_AGE_MS = 120_000;
/** Device clocks drift; beyond this a "future" fix is not a fix. */
export const MAX_SAMPLE_FUTURE_SKEW_MS = 60_000;
/** Worse than this the fix says nothing about where the mover is. */
export const MAX_ACCEPTABLE_ACCURACY_M = 250;
/** Consecutive responses that are not the contract before tracking stops fail-closed. */
export const MAX_MALFORMED_RESPONSES = 3;

export type SamplePolicyReason = 'NOT_FINITE' | 'OUT_OF_RANGE' | 'BEFORE_SESSION' | 'STALE' | 'FUTURE' | 'INACCURATE';

export function assessSample(
  sample: PublishableSample,
  sessionStartedAt: number,
  now: number,
): { ok: true } | { ok: false; reason: SamplePolicyReason } {
  if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) return { ok: false, reason: 'NOT_FINITE' };
  if (sample.latitude < -90 || sample.latitude > 90 || sample.longitude < -180 || sample.longitude > 180) return { ok: false, reason: 'OUT_OF_RANGE' };
  if (sample.timestamp !== undefined) {
    if (!Number.isFinite(sample.timestamp)) return { ok: false, reason: 'NOT_FINITE' };
    if (sample.timestamp < sessionStartedAt) return { ok: false, reason: 'BEFORE_SESSION' };
    if (now - sample.timestamp > MAX_SAMPLE_AGE_MS) return { ok: false, reason: 'STALE' };
    if (sample.timestamp - now > MAX_SAMPLE_FUTURE_SKEW_MS) return { ok: false, reason: 'FUTURE' };
  }
  if (sample.accuracy != null) {
    if (!Number.isFinite(sample.accuracy) || sample.accuracy < 0) return { ok: false, reason: 'NOT_FINITE' };
    if (sample.accuracy > MAX_ACCEPTABLE_ACCURACY_M) return { ok: false, reason: 'INACCURATE' };
  }
  return { ok: true };
}

export type Acceptance =
  | { kind: 'accepted' }
  | { kind: 'refused'; reason: string }
  | { kind: 'malformed' };

/** The publish contract, exactly: `{ accepted: true }` or `{ accepted: false, reason? }`. Anything else is not an answer. */
export function parseAcceptance(response: unknown): Acceptance {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return { kind: 'malformed' };
  const accepted = (response as { accepted?: unknown }).accepted;
  if (accepted === true) return { kind: 'accepted' };
  if (accepted === false) {
    const reason = (response as { reason?: unknown }).reason;
    return { kind: 'refused', reason: typeof reason === 'string' && reason.length > 0 && reason.length <= 64 ? reason : 'REFUSED' };
  }
  return { kind: 'malformed' };
}

const counters = {
  publication: new Map<string, number>(),
  restore: new Map<string, number>(),
  quality: new Map<string, number>(),
};
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

/** On-device counters: publication_accept_reason, lease_restore_result, quality_presence. Reasons only, never a coordinate. */
export function moverTrackingCounters(): { publication: Record<string, number>; restore: Record<string, number>; quality: Record<string, number> } {
  return { publication: Object.fromEntries(counters.publication), restore: Object.fromEntries(counters.restore), quality: Object.fromEntries(counters.quality) };
}

export function resetMoverTrackingCountersForTests(): void {
  counters.publication.clear();
  counters.restore.clear();
  counters.quality.clear();
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
    sample: Pick<BackgroundLocationSample, 'latitude' | 'longitude' | 'accuracy' | 'mocked'>,
    session: AuthSessionSnapshot,
  ) => Promise<unknown>;
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
  /** [MOB-017] Consecutive responses that were not the contract; a valid answer resets it. */
  malformedResponses: number;
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
    generation: session.owner.generation,
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

    // [MOB-017] Reauthorize on every restore: the record must name the
    // principal that is signed in NOW — same user AND same login generation.
    // A same-user relogin is a new boundary; the old record is retired.
    if (!auth || auth.userId !== durable.userId || auth.generation !== durable.generation) {
      bump(counters.restore, !auth ? 'no_auth' : auth.userId !== durable.userId ? 'user_mismatch' : 'generation_mismatch');
      await attemptDurableCleanup(durable);
      return { status: 'cleanup-pending' };
    }
    bump(counters.restore, 'restored');

    const restored: ActiveMoverLocationSession = {
      kind: durable.kind,
      startedAt: durable.startedAt,
      owner: { generation: auth.generation, userId: auth.userId },
      isLocallyAuthorized: () => true,
      lastPublishedAt: durable.lastPublishedAt,
      lastLatitude: durable.lastLatitude,
      lastLongitude: durable.lastLongitude,
      publishing: false,
      malformedResponses: 0,
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
    sample: PublishableSample,
    authSession: AuthSessionSnapshot,
  ): Promise<MoverLocationPublicationOutcome> => {
    if (
      activeSession !== session
      || !samePrincipalBoundary(authSession, session.owner)
      || !currentAuthorizedSession(session)
      || session.publishing
    ) return { published: false, reason: 'NOT_AUTHORIZED' };

    const publishedAt = dependencies.now();
    // [MOB-017] The policy first: range, age, skew, session start, accuracy.
    const verdict = assessSample(sample, session.startedAt, publishedAt);
    if (!verdict.ok) {
      bump(counters.publication, verdict.reason);
      return { published: false, reason: verdict.reason };
    }
    if (!shouldPublish(session, sample, publishedAt)) return { published: false, reason: 'THROTTLED' };
    bump(counters.quality, sample.accuracy != null ? 'accuracy_present' : 'accuracy_absent');
    bump(counters.quality, sample.mocked == null ? 'mocked_absent' : sample.mocked ? 'mocked_true' : 'mocked_false');

    session.publishing = true;
    try {
      // Quality rides along exactly as the platform reported it — never stripped, never invented.
      const response = await dependencies.publish(session.kind, {
        latitude: sample.latitude,
        longitude: sample.longitude,
        ...(sample.accuracy != null ? { accuracy: sample.accuracy } : {}),
        ...(sample.mocked != null ? { mocked: sample.mocked } : {}),
      }, authSession);
      const acceptance = parseAcceptance(response);
      if (acceptance.kind === 'refused') {
        bump(counters.publication, acceptance.reason);
        await retireSessionIfCurrent(session);
        dependencies.invalidateMoverQueries();
        return { published: true, accepted: false, reason: acceptance.reason };
      }
      if (acceptance.kind === 'malformed') {
        // Not an answer: no checkpoint, and repeated, no tracking. A server or
        // proxy that keeps answering with something else cannot sustain GPS.
        bump(counters.publication, 'MALFORMED_RESPONSE');
        session.malformedResponses += 1;
        if (session.malformedResponses >= MAX_MALFORMED_RESPONSES) {
          await retireSessionIfCurrent(session);
          dependencies.invalidateMoverQueries();
          return { published: true, reason: 'MALFORMED_RESPONSE_LIMIT' };
        }
        return { published: true, reason: 'MALFORMED_RESPONSE' };
      }
      session.malformedResponses = 0;
      bump(counters.publication, 'ACCEPTED');
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
      return { published: true, accepted: true, reason: 'ACCEPTED' };
    } catch {
      if (!currentAuthorizedSession(session)) {
        await retireSessionIfCurrent(session);
      }
      bump(counters.publication, 'TRANSPORT_ERROR');
      return { published: true, reason: 'TRANSPORT_ERROR' };
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
    // [MOB-017] Everything the platform reported goes to the one policy and
    // the one publication path — timestamp, accuracy and mock flag included.
    await publishSample(session, last, authSession);
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
        malformedResponses: 0,
      };
      activeSession = session;
      installed = session;

      try {
        await dependencies.writePersistedSession(encodeMoverLocationSession({
          kind,
          startedAt,
          userId: owner.userId,
          generation: owner.generation,
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
    sample: PublishableSample,
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
