import { describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';
import {
  assessSample,
  createMoverBackgroundLocationRuntime,
  LOCATION_CLEANUP_BASE_BACKOFF_MS,
  MAX_ACCEPTABLE_ACCURACY_M,
  MAX_LOCATION_SILENCE_MS,
  MAX_MALFORMED_RESPONSES,
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLE_FUTURE_SKEW_MS,
  moverTrackingCounters,
  parseAcceptance,
  resetMoverTrackingCountersForTests,
  type MoverBackgroundRuntimeDependencies,
} from '../lib/moverBackgroundRuntime';
import {
  decodeMoverLocationSession,
  encodeMoverLocationSession,
} from '../lib/moverBackgroundSession';

const accountA: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-a',
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
};
const accountANewGeneration = { ...accountA, generation: 2 };
const accountB: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-b',
  accessToken: 'access-b',
  refreshToken: 'refresh-b',
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function durable(userId: string, kind: 'DRIVER' | 'RIDER' = 'DRIVER', generation = 1) {
  return encodeMoverLocationSession({ kind, startedAt: 90_000, userId, generation });
}

function harness({
  auth = null,
  persisted = null,
  nativeRunning = false,
}: {
  auth?: AuthSessionSnapshot | null;
  persisted?: string | null;
  nativeRunning?: boolean;
} = {}) {
  const state = { auth, persisted, nativeRunning, now: 100_000 };
  const initializeAuthStorage = vi.fn().mockResolvedValue(undefined);
  const rehydrateAuth = vi.fn().mockResolvedValue(undefined);
  const readPersistedSession = vi.fn(async () => state.persisted);
  const writePersistedSession = vi.fn(async (raw: string) => {
    state.persisted = raw;
  });
  const deletePersistedSession = vi.fn(async () => {
    state.persisted = null;
  });
  const startNative = vi.fn(async () => {
    state.nativeRunning = true;
  });
  const stopNative = vi.fn(async () => {
    state.nativeRunning = false;
  });
  const publish = vi.fn().mockResolvedValue({ accepted: true });
  const invalidateMoverQueries = vi.fn();
  const dependencies: MoverBackgroundRuntimeDependencies = {
    now: () => state.now,
    getAuthSession: () => state.auth,
    initializeAuthStorage,
    rehydrateAuth,
    readPersistedSession,
    writePersistedSession,
    deletePersistedSession,
    hasForegroundPermission: vi.fn().mockResolvedValue(true),
    hasBackgroundPermission: vi.fn().mockResolvedValue(true),
    isNativeRunning: vi.fn(async () => state.nativeRunning),
    startNative,
    stopNative,
    publish,
    invalidateMoverQueries,
  };
  const runtime = createMoverBackgroundLocationRuntime(dependencies);
  const createRuntime = () => createMoverBackgroundLocationRuntime(dependencies);
  const deliver = (
    target = runtime,
    sample = { latitude: 6.81234, longitude: -58.14321 },
    timestamp = state.now,
  ) => target.handleTask({
    locations: [{ ...sample, timestamp }],
  });
  return {
    state,
    dependencies,
    runtime,
    createRuntime,
    deliver,
    initializeAuthStorage,
    rehydrateAuth,
    readPersistedSession,
    writePersistedSession,
    deletePersistedSession,
    startNative,
    stopNative,
    publish,
    invalidateMoverQueries,
  };
}

describe('background mover location service', () => {
  it('starts and publishes with the exact authority snapshot that acquired GPS', async () => {
    const h = harness({ auth: accountA });

    await expect(h.runtime.start('DRIVER', () => true)).resolves.toBe(true);
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      kind: 'DRIVER',
      userId: 'account-a',
    });
    await h.deliver(h.runtime);

    expect(h.publish).toHaveBeenCalledWith(
      'DRIVER',
      { latitude: 6.81234, longitude: -58.14321 },
      accountA,
    );
  });

  it('retires durable A without publishing when encrypted auth belongs to B', async () => {
    const h = harness({
      auth: accountB,
      persisted: durable('account-a'),
      nativeRunning: true,
    });

    await h.deliver(h.runtime);

    expect(h.publish).not.toHaveBeenCalled();
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
  });

  it('invalidates active GPS when the same user crosses a login generation', async () => {
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);

    h.state.auth = accountANewGeneration;
    await h.deliver(h.runtime);

    expect(h.publish).not.toHaveBeenCalled();
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
  });

  it('rechecks the interactive account after secure storage opens during restore', async () => {
    const h = harness({ persisted: durable('account-a'), nativeRunning: true });
    const storageReady = deferred();
    h.initializeAuthStorage.mockReturnValue(storageReady.promise);

    const restoring = h.deliver(h.runtime);
    await vi.waitFor(() => expect(h.initializeAuthStorage).toHaveBeenCalledOnce());
    h.state.auth = accountB;
    storageReady.resolve();
    await restoring;

    expect(h.rehydrateAuth).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
  });

  it('pins an in-flight A publish and cannot retire a concurrently installed B', async () => {
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    const response = deferred<{ accepted: boolean }>();
    h.publish.mockReturnValue(response.promise);

    const publishingA = h.deliver(h.runtime);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    h.state.auth = accountB;
    await expect(h.runtime.start('RIDER', () => true)).resolves.toBe(true);
    response.resolve({ accepted: true });
    await publishingA;

    expect(h.publish.mock.calls[0]?.[2]).toEqual(accountA);
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      kind: 'RIDER',
      userId: 'account-b',
    });
    expect(h.stopNative).not.toHaveBeenCalled();
  });

  it('serializes a replacement after native startup rejects', async () => {
    const h = harness({ auth: accountA });
    const nativeA = deferred();
    h.startNative
      .mockImplementationOnce(() => nativeA.promise)
      .mockImplementationOnce(async () => {
        h.state.nativeRunning = true;
      });

    const startingA = h.runtime.start('DRIVER', () => true);
    await vi.waitFor(() => expect(h.startNative).toHaveBeenCalledOnce());
    h.state.auth = accountB;
    const startingB = h.runtime.start('RIDER', () => true);
    nativeA.reject(new Error('Core Location start failed'));

    await expect(startingA).resolves.toBe(false);
    await expect(startingB).resolves.toBe(true);
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      kind: 'RIDER',
      userId: 'account-b',
    });
  });

  it('recovers after a secure-storage write failure without leaking A ownership', async () => {
    const h = harness({ auth: accountA });
    h.writePersistedSession.mockRejectedValueOnce(new Error('Keychain write unavailable'));

    await expect(h.runtime.start('DRIVER', () => true)).resolves.toBe(false);
    h.state.auth = accountB;
    await expect(h.runtime.start('RIDER', () => true)).resolves.toBe(true);

    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      kind: 'RIDER',
      userId: 'account-b',
    });
  });

  it('retires native and durable state when the server returns accepted:false', async () => {
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    h.publish.mockResolvedValue({ accepted: false });

    await h.deliver(h.runtime);
    await h.deliver(h.runtime);

    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(h.invalidateMoverQueries).toHaveBeenCalledOnce();
  });

  it('fails closed on every cold-launch event when durable authority is unreadable', async () => {
    const h = harness({
      auth: accountA,
      persisted: durable('account-a'),
      nativeRunning: true,
    });
    h.readPersistedSession.mockRejectedValue(new Error('Keychain not unlocked'));

    await h.deliver(h.createRuntime());
    h.state.nativeRunning = true;
    await h.deliver(h.createRuntime());

    expect(h.publish).not.toHaveBeenCalled();
    expect(h.deletePersistedSession).not.toHaveBeenCalled();
    expect(h.stopNative).toHaveBeenCalledTimes(2);
  });

  it('deduplicates foreground/background samples but publishes meaningful movement promptly', async () => {
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);

    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321 });
    await h.runtime.publishForeground(
      'DRIVER',
      { latitude: 6.81234, longitude: -58.14321 },
      accountA,
    );
    expect(h.publish).toHaveBeenCalledOnce();

    h.state.now += 8_000;
    await h.deliver(h.runtime, { latitude: 6.816, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledTimes(2);

    h.state.now += MAX_LOCATION_SILENCE_MS - 1;
    await h.deliver(h.runtime, { latitude: 6.816, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledTimes(2);
    h.state.now += 1;
    await h.deliver(h.runtime, { latitude: 6.816, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledTimes(3);
  });

  it('persists the movement gate across a fresh task runtime for every event', async () => {
    const h = harness({
      auth: accountA,
      persisted: durable('account-a'),
      nativeRunning: true,
    });

    await h.deliver(h.createRuntime(), { latitude: 6.81234, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledOnce();

    h.state.now += 5_000;
    await h.deliver(h.createRuntime(), { latitude: 6.81235, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledOnce();

    h.state.now += 3_000;
    await h.deliver(h.createRuntime(), { latitude: 6.816, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      lastPublishedAt: h.state.now,
      lastLatitude: 6.816,
      lastLongitude: -58.14321,
    });
  });

  it('fails closed when an accepted publication cannot checkpoint durable throttle state', async () => {
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    h.writePersistedSession.mockRejectedValueOnce(new Error('encrypted MMKV unavailable'));

    await h.deliver(h.runtime);
    await h.deliver(h.createRuntime());

    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(h.state.persisted).toBeNull();
  });

  it('attempts unregister on an unknown native probe and reports cleanup pending', async () => {
    const h = harness({ auth: accountA, nativeRunning: true });
    await h.runtime.start('DRIVER', () => true);
    vi.mocked(h.dependencies.isNativeRunning).mockRejectedValueOnce(new Error('native probe failed'));

    await expect(h.runtime.stop(accountA)).resolves.toBe(false);

    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      cleanupPending: true,
      cleanupAttempts: 1,
    });
  });

  it('persists a tombstone and retries a failed native stop from a fresh runtime', async () => {
    const h = harness({ auth: accountA, nativeRunning: true });
    await h.runtime.start('DRIVER', () => true);
    h.stopNative.mockRejectedValueOnce(new Error('native stop failed'));

    await expect(h.runtime.stop(accountA)).resolves.toBe(false);
    const tombstone = decodeMoverLocationSession(h.state.persisted);
    expect(tombstone).toMatchObject({ cleanupPending: true, cleanupAttempts: 1 });

    await h.deliver(h.createRuntime());
    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();

    h.state.now += LOCATION_CLEANUP_BASE_BACKOFF_MS;
    await h.deliver(h.createRuntime());
    expect(h.stopNative).toHaveBeenCalledTimes(2);
    expect(h.state.persisted).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('removes publishable authority when tombstone write and native stop both fail', async () => {
    const h = harness({ auth: accountA, nativeRunning: true });
    await h.runtime.start('DRIVER', () => true);
    h.writePersistedSession.mockRejectedValueOnce(new Error('tombstone write failed'));
    h.stopNative.mockRejectedValueOnce(new Error('native stop failed'));

    await expect(h.runtime.stop(accountA)).resolves.toBe(false);

    expect(h.state.persisted).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('reports delete failure and lets a fresh runtime finish tombstone cleanup', async () => {
    const h = harness({ auth: accountA, nativeRunning: true });
    await h.runtime.start('DRIVER', () => true);
    h.deletePersistedSession.mockRejectedValueOnce(new Error('Keychain delete failed'));

    await expect(h.runtime.stop(accountA)).resolves.toBe(false);
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({
      cleanupPending: true,
      cleanupAttempts: 1,
    });

    h.state.now += LOCATION_CLEANUP_BASE_BACKOFF_MS;
    await h.deliver(h.createRuntime());

    expect(h.state.persisted).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('does not report cleanup success when authority read and fallback delete fail', async () => {
    const h = harness({ auth: accountA, persisted: durable('account-a') });
    h.readPersistedSession.mockRejectedValueOnce(new Error('Keychain read failed'));
    h.deletePersistedSession.mockRejectedValueOnce(new Error('Keychain delete failed'));

    await expect(h.runtime.stop(accountA)).resolves.toBe(false);

    expect(h.deletePersistedSession).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [MOB-017 / TST-012] Quality evidence survives every path; only a schema-valid
// accepted:true checkpoints; the durable record is bound to the login
// generation and reauthorized on every restore.
// ---------------------------------------------------------------------------

describe('[MOB-017] quality evidence reaches the publish call exactly as the platform reported it', () => {
  it('a native fix keeps its accuracy and mock flag; an old-shaped fix stays old-shaped', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321, accuracy: 12.5, mocked: true } as never);
    expect(h.publish).toHaveBeenLastCalledWith('DRIVER', { latitude: 6.81234, longitude: -58.14321, accuracy: 12.5, mocked: true }, accountA);
    h.state.now += 8_000;
    await h.deliver(h.runtime, { latitude: 6.816, longitude: -58.14321, accuracy: 7, mocked: false } as never);
    expect(h.publish).toHaveBeenLastCalledWith('DRIVER', { latitude: 6.816, longitude: -58.14321, accuracy: 7, mocked: false }, accountA);
    h.state.now += 8_000;
    await h.deliver(h.runtime, { latitude: 6.82, longitude: -58.14321 });
    expect(h.publish).toHaveBeenLastCalledWith('DRIVER', { latitude: 6.82, longitude: -58.14321 }, accountA);
    expect(moverTrackingCounters().quality).toEqual({ accuracy_present: 2, mocked_true: 1, mocked_false: 1, accuracy_absent: 1, mocked_absent: 1 });
  });

  it('a foreground fix keeps its quality too', async () => {
    const h = harness({ auth: accountA });
    await h.runtime.start('RIDER', () => true);
    await h.runtime.publishForeground('RIDER', { latitude: 6.81234, longitude: -58.14321, accuracy: 30, mocked: false }, accountA);
    expect(h.publish).toHaveBeenLastCalledWith('RIDER', { latitude: 6.81234, longitude: -58.14321, accuracy: 30, mocked: false }, accountA);
  });
});

describe('[MOB-017] the sample policy: range, age, skew, session start, accuracy — and a mock fix is published WITH its flag', () => {
  it('assesses samples as a pure function', () => {
    const start = 90_000; const now = 100_000;
    expect(assessSample({ latitude: 6.8, longitude: -58.1, timestamp: now }, start, now)).toEqual({ ok: true });
    expect(assessSample({ latitude: 91, longitude: -58.1 }, start, now)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(assessSample({ latitude: 6.8, longitude: -181 }, start, now)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(assessSample({ latitude: Number.NaN, longitude: -58.1 }, start, now)).toEqual({ ok: false, reason: 'NOT_FINITE' });
    expect(assessSample({ latitude: 6.8, longitude: -58.1, timestamp: start - 1 }, start, now)).toEqual({ ok: false, reason: 'BEFORE_SESSION' });
    expect(assessSample({ latitude: 6.8, longitude: -58.1, timestamp: 1_000_000 - MAX_SAMPLE_AGE_MS - 1 }, 0, 1_000_000)).toEqual({ ok: false, reason: 'STALE' });
    expect(assessSample({ latitude: 6.8, longitude: -58.1, timestamp: now + MAX_SAMPLE_FUTURE_SKEW_MS + 1 }, start, now)).toEqual({ ok: false, reason: 'FUTURE' });
    expect(assessSample({ latitude: 6.8, longitude: -58.1, accuracy: MAX_ACCEPTABLE_ACCURACY_M + 1 }, start, now)).toEqual({ ok: false, reason: 'INACCURATE' });
    expect(assessSample({ latitude: 6.8, longitude: -58.1, accuracy: -1 }, start, now)).toEqual({ ok: false, reason: 'NOT_FINITE' });
    expect(assessSample({ latitude: 6.8, longitude: -58.1, accuracy: MAX_ACCEPTABLE_ACCURACY_M, mocked: true }, start, now)).toEqual({ ok: true });
  });

  it('the runtime publishes nothing for an out-of-range, stale, future or hopelessly inaccurate fix, counts why, and never checkpoints it', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    h.state.now = 1_000_000; // well past the session start, so age and skew are judged on their own
    await h.deliver(h.runtime, { latitude: 91, longitude: -58.14321 });
    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321 }, h.state.now - MAX_SAMPLE_AGE_MS - 1_000);
    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321 }, h.state.now + MAX_SAMPLE_FUTURE_SKEW_MS + 1_000);
    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321, accuracy: 900 } as never);
    expect(h.publish).not.toHaveBeenCalled();
    expect(moverTrackingCounters().publication).toEqual({ OUT_OF_RANGE: 1, STALE: 1, FUTURE: 1, INACCURATE: 1 });
    expect(decodeMoverLocationSession(h.state.persisted)?.lastPublishedAt).toBeUndefined();
    // a mock fix IS published, flagged — the server's plausibility check wants that evidence
    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321, mocked: true } as never);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenLastCalledWith('DRIVER', { latitude: 6.81234, longitude: -58.14321, mocked: true }, accountA);
    expect(moverTrackingCounters().publication['ACCEPTED']).toBe(1);
  });
});

describe('[MOB-017] only a schema-valid accepted:true checkpoints', () => {
  it('parses the contract exactly', () => {
    expect(parseAcceptance({ accepted: true })).toEqual({ kind: 'accepted' });
    expect(parseAcceptance({ accepted: false, reason: 'SESSION_REPLACED' })).toEqual({ kind: 'refused', reason: 'SESSION_REPLACED' });
    expect(parseAcceptance({ accepted: false })).toEqual({ kind: 'refused', reason: 'REFUSED' });
    for (const bad of [null, undefined, {}, { accepted: null }, { accepted: 'true' }, { accepted: 1 }, '<html>', [], 'accepted', { data: { accepted: true } }]) {
      expect(parseAcceptance(bad), JSON.stringify(bad)).toEqual({ kind: 'malformed' });
    }
  });

  it('a null, absent, string or HTML response never checkpoints; after the bound it retires fail-closed', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    const responses: unknown[] = [{ accepted: null }, undefined, '<html>captive portal</html>'];
    for (const r of responses) {
      h.publish.mockResolvedValueOnce(r);
      h.state.now += 8_000;
      await h.deliver(h.runtime, { latitude: 6.8 + h.state.now / 1e6, longitude: -58.14321 });
    }
    expect(h.publish).toHaveBeenCalledTimes(MAX_MALFORMED_RESPONSES);
    expect(decodeMoverLocationSession(h.state.persisted)).toBeNull(); // retired at the bound
    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(h.invalidateMoverQueries).toHaveBeenCalledOnce();
    expect(moverTrackingCounters().publication).toEqual({ MALFORMED_RESPONSE: 3 });
  });

  it('a malformed answer between valid ones neither checkpoints nor accumulates past a valid one', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    h.publish.mockResolvedValueOnce({ accepted: null });
    await h.deliver(h.runtime, { latitude: 6.81234, longitude: -58.14321 });
    expect(decodeMoverLocationSession(h.state.persisted)?.lastPublishedAt).toBeUndefined();
    h.state.now += 8_000;
    await h.deliver(h.runtime, { latitude: 6.816, longitude: -58.14321 }); // accepted:true (the harness default)
    expect(decodeMoverLocationSession(h.state.persisted)?.lastPublishedAt).toBe(h.state.now);
    for (let i = 0; i < MAX_MALFORMED_RESPONSES - 1; i += 1) {
      h.publish.mockResolvedValueOnce({});
      h.state.now += 8_000;
      await h.deliver(h.runtime, { latitude: 6.82 + i / 100, longitude: -58.14321 });
    }
    expect(decodeMoverLocationSession(h.state.persisted)).not.toBeNull(); // two after a valid one is under the bound
    expect(h.stopNative).not.toHaveBeenCalled();
  });

  it('a refusal retires with the server’s reason counted', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    h.publish.mockResolvedValue({ accepted: false, reason: 'SESSION_REPLACED' });
    await h.deliver(h.runtime);
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(moverTrackingCounters().publication).toEqual({ SESSION_REPLACED: 1 });
  });
});

describe('[MOB-017] the durable record is bound to the login generation and reauthorized on every restore', () => {
  it('start persists the generation; a fresh runtime restores only the SAME user AND generation, rotated tokens included', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountA });
    await h.runtime.start('DRIVER', () => true);
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({ userId: 'account-a', generation: 1 });
    // an accepted checkpoint rewrites the record — the generation must survive that path too
    await h.deliver(h.runtime);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(decodeMoverLocationSession(h.state.persisted)).toMatchObject({ userId: 'account-a', generation: 1, lastPublishedAt: h.state.now });
    // a fresh runtime under the same principal with rotated tokens restores and keeps publishing
    h.state.auth = { ...accountA, accessToken: 'access-a-2', refreshToken: 'refresh-a-2' };
    h.state.now += 8_000;
    await h.deliver(h.createRuntime(), { latitude: 6.816, longitude: -58.14321 });
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(moverTrackingCounters().restore).toEqual({ restored: 1 });
  });

  it('a same-user relogin (new generation) from a fresh runtime retires the record and stops native tracking — never resurrects', async () => {
    resetMoverTrackingCountersForTests();
    const h = harness({ auth: accountANewGeneration, persisted: durable('account-a', 'DRIVER', 1), nativeRunning: true });
    await h.deliver(h.createRuntime());
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
    expect(moverTrackingCounters().restore).toEqual({ generation_mismatch: 1 });
    // and the new generation has to go online explicitly — nothing restores on its own
    await h.deliver(h.createRuntime());
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('another user, or no user at all, is counted as such and retired', async () => {
    resetMoverTrackingCountersForTests();
    const other = harness({ auth: accountB, persisted: durable('account-a'), nativeRunning: true });
    await other.deliver(other.createRuntime());
    expect(other.publish).not.toHaveBeenCalled();
    expect(moverTrackingCounters().restore).toEqual({ user_mismatch: 1 });
    resetMoverTrackingCountersForTests();
    const nobody = harness({ auth: null, persisted: durable('account-a'), nativeRunning: true });
    await nobody.deliver(nobody.createRuntime());
    expect(nobody.publish).not.toHaveBeenCalled();
    expect(nobody.stopNative).toHaveBeenCalledOnce();
    expect(moverTrackingCounters().restore).toEqual({ no_auth: 1 });
  });

  it('a legacy record without a generation is unknown authority: native stopped, record removed, nothing published', async () => {
    const h = harness({ auth: accountA, persisted: JSON.stringify({ kind: 'DRIVER', startedAt: 90_000, userId: 'account-a' }), nativeRunning: true });
    await h.deliver(h.createRuntime());
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.state.persisted).toBeNull();
    expect(h.stopNative).toHaveBeenCalledOnce();
  });
});
