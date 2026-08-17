import { describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';
import {
  createMoverBackgroundLocationRuntime,
  LOCATION_CLEANUP_BASE_BACKOFF_MS,
  MAX_LOCATION_SILENCE_MS,
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

function durable(userId: string, kind: 'DRIVER' | 'RIDER' = 'DRIVER') {
  return encodeMoverLocationSession({ kind, startedAt: 90_000, userId });
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
