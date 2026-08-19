import { describe, expect, it, vi } from 'vitest';
import {
  commitLiveDeviceLocation,
  createLiveDeviceLocationLease,
  resolveCoordinatedDeviceLocation,
  type DeviceLocationApi,
  type DeviceLocationWriter,
  type LocationStatus,
} from './deviceLocation';
import {
  createMoverLocationController,
  MOVER_LOCATION_HEARTBEAT_MS,
  prepareMoverOnline,
  requestUsableMoverBackgroundPermission,
  shouldTrackMoverLocation,
  startMoverLocationSession,
  type MoverLocationSample,
  type MoverLocationSessionDependencies,
  type MoverLocationSubscription,
} from './moverLocation';

describe('shouldTrackMoverLocation', () => {
  it('restores tracking for a force-offlined mover who still owns an active job', () => {
    expect(shouldTrackMoverLocation(false, { id: 'active-trip' })).toBe(true);
  });

  it('does not track idle offline supply', () => {
    expect(shouldTrackMoverLocation(false, null)).toBe(false);
  });

  it('tracks online idle supply while it waits for work', () => {
    expect(shouldTrackMoverLocation(true, null)).toBe(true);
  });
});

function locationApi(status: 'granted' | 'denied'): DeviceLocationApi {
  return {
    getForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status }),
    requestForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status }),
    getCurrentPositionAsync: vi.fn().mockResolvedValue({
      coords: { latitude: 6.81234, longitude: -58.14321 },
    }),
    reverseGeocodeAsync: vi.fn().mockResolvedValue([
      { name: 'Regent Street', city: 'Georgetown' },
    ]),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sharedWriter() {
  let status: LocationStatus = 'unknown';
  let latitude: number | null = null;
  let longitude: number | null = null;
  const setLocation = vi.fn((nextLatitude: number, nextLongitude: number) => {
    latitude = nextLatitude;
    longitude = nextLongitude;
    status = 'granted';
  });
  const writer: DeviceLocationWriter = {
    setStatus: vi.fn((next: LocationStatus) => {
      status = next;
    }),
    setLocation,
  };
  return {
    writer,
    liveWriter: { setLiveLocation: setLocation },
    status: () => status,
    fix: () => status === 'granted' && latitude !== null && longitude !== null
      ? { latitude, longitude }
      : null,
  };
}

async function grantedLease(writer: DeviceLocationWriter) {
  await resolveCoordinatedDeviceLocation('request', locationApi('granted'), writer);
  const lease = createLiveDeviceLocationLease();
  expect(lease).not.toBeNull();
  return lease!;
}

describe('prepareMoverOnline', () => {
  it('uses the explicit GO action to commit a fresh grant before going online', async () => {
    const shared = sharedWriter();
    const requestBackground = vi.fn().mockResolvedValue(true);
    const goOnline = vi.fn().mockResolvedValue(undefined);

    await expect(prepareMoverOnline({
      resolveForeground: () => resolveCoordinatedDeviceLocation(
        'request',
        locationApi('granted'),
        shared.writer,
      ),
      requestBackground,
      getForegroundFix: shared.fix,
      goOnline,
    })).resolves.toMatchObject({ status: 'granted' });

    expect(shared.status()).toBe('granted');
    expect(shared.writer.setLocation).toHaveBeenCalledWith(
      6.81234,
      -58.14321,
      'Regent Street, Georgetown',
    );
    expect(requestBackground).toHaveBeenCalledOnce();
    expect(goOnline).toHaveBeenCalledOnce();
    expect(goOnline).toHaveBeenCalledWith({ latitude: 6.81234, longitude: -58.14321 });
  });

  it('does not request background access or go online after foreground denial', async () => {
    const shared = sharedWriter();
    const requestBackground = vi.fn();
    const goOnline = vi.fn();

    await expect(prepareMoverOnline({
      resolveForeground: () => resolveCoordinatedDeviceLocation(
        'request',
        locationApi('denied'),
        shared.writer,
      ),
      requestBackground,
      getForegroundFix: shared.fix,
      goOnline,
    })).resolves.toEqual({ status: 'denied' });

    expect(requestBackground).not.toHaveBeenCalled();
    expect(goOnline).not.toHaveBeenCalled();
  });

  it('falls back to foreground streaming when the background upgrade fails', async () => {
    const shared = sharedWriter();
    const goOnline = vi.fn().mockResolvedValue(undefined);

    await prepareMoverOnline({
      resolveForeground: () => resolveCoordinatedDeviceLocation(
        'request',
        locationApi('granted'),
        shared.writer,
      ),
      requestBackground: vi.fn().mockRejectedValue(new Error('background denied')),
      getForegroundFix: shared.fix,
      goOnline,
    });

    expect(goOnline).toHaveBeenCalledOnce();
    expect(goOnline).toHaveBeenCalledWith({ latitude: 6.81234, longitude: -58.14321 });
  });

  it('does not go online when foreground authority is revoked during the background upgrade', async () => {
    const shared = sharedWriter();
    const background = deferred<boolean>();
    const requestBackground = vi.fn().mockReturnValue(background.promise);
    const goOnline = vi.fn();

    const pending = prepareMoverOnline({
      resolveForeground: () => resolveCoordinatedDeviceLocation(
        'request',
        locationApi('granted'),
        shared.writer,
      ),
      requestBackground,
      getForegroundFix: shared.fix,
      goOnline,
    });
    await vi.waitFor(() => expect(requestBackground).toHaveBeenCalledOnce());

    await resolveCoordinatedDeviceLocation('silent', locationApi('denied'), shared.writer);
    background.resolve(true);

    await expect(pending).resolves.toEqual({ status: 'unavailable' });
    expect(shared.status()).toBe('denied');
    expect(goOnline).not.toHaveBeenCalled();
  });

  it('sends the newer canonical fix when a silent grant supersedes the pre-settings fix', async () => {
    const shared = sharedWriter();
    const background = deferred<boolean>();
    const requestBackground = vi.fn().mockReturnValue(background.promise);
    const goOnline = vi.fn().mockResolvedValue(undefined);

    const pending = prepareMoverOnline({
      resolveForeground: () => resolveCoordinatedDeviceLocation(
        'request',
        locationApi('granted'),
        shared.writer,
      ),
      requestBackground,
      getForegroundFix: shared.fix,
      goOnline,
    });
    await vi.waitFor(() => expect(requestBackground).toHaveBeenCalledOnce());

    const newerApi = locationApi('granted');
    vi.mocked(newerApi.getCurrentPositionAsync).mockResolvedValue({
      coords: { latitude: 6.91, longitude: -58.21 },
    });
    await resolveCoordinatedDeviceLocation('silent', newerApi, shared.writer);
    background.resolve(true);

    await expect(pending).resolves.toMatchObject({ status: 'granted' });
    expect(goOnline).toHaveBeenCalledWith({ latitude: 6.91, longitude: -58.21 });
  });
});

describe('requestUsableMoverBackgroundPermission', () => {
  it('does not prompt when the installed binary lacks TaskManager', async () => {
    const getForegroundPermission = vi.fn();
    const requestBackgroundPermission = vi.fn();

    await expect(requestUsableMoverBackgroundPermission({
      taskManagerAvailable: false,
      getForegroundPermission,
      requestBackgroundPermission,
    })).resolves.toBe(false);

    expect(getForegroundPermission).not.toHaveBeenCalled();
    expect(requestBackgroundPermission).not.toHaveBeenCalled();
  });

  it('requests the background upgrade only after an existing foreground grant', async () => {
    const requestBackgroundPermission = vi.fn().mockResolvedValue({ status: 'granted' });

    await expect(requestUsableMoverBackgroundPermission({
      taskManagerAvailable: true,
      getForegroundPermission: vi.fn().mockResolvedValue({ status: 'granted' }),
      requestBackgroundPermission,
    })).resolves.toBe(true);

    expect(requestBackgroundPermission).toHaveBeenCalledOnce();
  });
});

describe('startMoverLocationSession', () => {
  it('publishes meaningful foreground movement while background tracking is active', async () => {
    const shared = sharedWriter();
    const lease = await grantedLease(shared.writer);
    let onSample: ((sample: MoverLocationSample) => void) | undefined;
    const subscription: MoverLocationSubscription = { remove: vi.fn() };
    const publish = vi.fn();

    const session = await startMoverLocationSession(
      'DRIVER',
      {
        startBackground: vi.fn().mockResolvedValue(true),
        stopBackground: vi.fn(),
        watchForeground: vi.fn(async (listener) => {
          onSample = listener;
          return subscription;
        }),
        refreshForegroundSample: vi.fn().mockResolvedValue({ latitude: 6.91, longitude: -58.21 }),
        commitSharedSample: (sample) => commitLiveDeviceLocation(
          lease,
          shared.liveWriter,
          sample.latitude,
          sample.longitude,
        ),
        publish,
      },
      () => false,
    );

    expect(session).toMatchObject({ background: true, subscription });
    expect(session.heartbeat).toBeDefined();
    onSample?.({ latitude: 6.91, longitude: -58.21 });
    expect(shared.writer.setLocation).toHaveBeenLastCalledWith(6.91, -58.21);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith('DRIVER', { latitude: 6.91, longitude: -58.21 });
  });

  it('publishes foreground samples when background streaming is unavailable', async () => {
    const shared = sharedWriter();
    const lease = await grantedLease(shared.writer);
    let onSample: ((sample: MoverLocationSample) => void) | undefined;
    const subscription: MoverLocationSubscription = { remove: vi.fn() };
    const publish = vi.fn().mockResolvedValue(undefined);

    const session = await startMoverLocationSession(
      'RIDER',
      {
        startBackground: vi.fn().mockResolvedValue(false),
        stopBackground: vi.fn(),
        watchForeground: vi.fn(async (listener) => {
          onSample = listener;
          return subscription;
        }),
        refreshForegroundSample: vi.fn().mockResolvedValue({ latitude: 6.91, longitude: -58.21 }),
        commitSharedSample: (sample) => commitLiveDeviceLocation(
          lease,
          shared.liveWriter,
          sample.latitude,
          sample.longitude,
        ),
        publish,
      },
      () => false,
    );

    expect(session).toMatchObject({ background: false, subscription });
    expect(session.heartbeat).toBeDefined();
    onSample?.({ latitude: 6.91, longitude: -58.21 });
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith('RIDER', { latitude: 6.91, longitude: -58.21 });
  });

  it('renews a parked foreground fix before the server dispatch lease expires', async () => {
    vi.useFakeTimers();
    try {
      let onSample: ((sample: MoverLocationSample) => void) | undefined;
      const publish = vi.fn().mockResolvedValue(undefined);
      const refreshForegroundSample = vi.fn().mockResolvedValue({ latitude: 6.91, longitude: -58.21 });
      const session = await startMoverLocationSession(
        'DRIVER',
        {
          startBackground: vi.fn().mockResolvedValue(true),
          stopBackground: vi.fn(),
          watchForeground: vi.fn(async (listener) => {
            onSample = listener;
            return { remove: vi.fn() };
          }),
          refreshForegroundSample,
          commitSharedSample: vi.fn().mockReturnValue(true),
          publish,
        },
        () => false,
      );

      onSample?.({ latitude: 6.91, longitude: -58.21 });
      expect(publish).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(MOVER_LOCATION_HEARTBEAT_MS);
      expect(refreshForegroundSample).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenLastCalledWith('DRIVER', { latitude: 6.91, longitude: -58.21 });
      if (session.heartbeat) clearInterval(session.heartbeat);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never renews the server lease from a stale cached sample when the OS fix stalls', async () => {
    vi.useFakeTimers();
    try {
      let onSample: ((sample: MoverLocationSample) => void) | undefined;
      const publish = vi.fn();
      const session = await startMoverLocationSession(
        'DRIVER',
        {
          startBackground: vi.fn().mockResolvedValue(true),
          stopBackground: vi.fn(),
          watchForeground: vi.fn(async (listener) => {
            onSample = listener;
            return { remove: vi.fn() };
          }),
          refreshForegroundSample: vi.fn().mockRejectedValue(new Error('location services unavailable')),
          commitSharedSample: vi.fn().mockReturnValue(true),
          publish,
        },
        () => false,
      );

      // One real watcher sample is allowed to update the shared map, but it is
      // not replayed as fresh authority after native refreshes start failing.
      onSample?.({ latitude: 6.91, longitude: -58.21 });
      expect(publish).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(MOVER_LOCATION_HEARTBEAT_MS * 4);
      expect(publish).toHaveBeenCalledOnce();
      if (session.heartbeat) clearInterval(session.heartbeat);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops both the store write and upload after its location lease is invalidated', async () => {
    const shared = sharedWriter();
    const lease = await grantedLease(shared.writer);
    let onSample: ((sample: MoverLocationSample) => void) | undefined;
    const publish = vi.fn();

    await startMoverLocationSession(
      'DRIVER',
      {
        startBackground: vi.fn().mockResolvedValue(false),
        stopBackground: vi.fn(),
        watchForeground: vi.fn(async (listener) => {
          onSample = listener;
          return { remove: vi.fn() };
        }),
        refreshForegroundSample: vi.fn().mockResolvedValue({ latitude: 6.91, longitude: -58.21 }),
        commitSharedSample: (sample) => commitLiveDeviceLocation(
          lease,
          shared.liveWriter,
          sample.latitude,
          sample.longitude,
        ),
        publish,
      },
      () => false,
    );

    await resolveCoordinatedDeviceLocation('silent', locationApi('denied'), shared.writer);
    vi.mocked(shared.writer.setLocation).mockClear();
    onSample?.({ latitude: 6.91, longitude: -58.21 });
    await Promise.resolve();

    expect(shared.writer.setLocation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops a background task that finishes starting after cancellation', async () => {
    const backgroundStarted = deferred<boolean>();
    const startBackground = vi.fn().mockReturnValue(backgroundStarted.promise);
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    let cancelled = false;

    const pending = startMoverLocationSession(
      'DRIVER',
      {
        startBackground,
        stopBackground,
        watchForeground: vi.fn(),
        refreshForegroundSample: vi.fn(),
        commitSharedSample: vi.fn().mockReturnValue(true),
        publish: vi.fn(),
      },
      () => cancelled,
    );

    await vi.waitFor(() => expect(startBackground).toHaveBeenCalledOnce());
    cancelled = true;
    backgroundStarted.resolve(true);

    await expect(pending).resolves.toEqual({ background: false });
    expect(stopBackground).toHaveBeenCalledOnce();
  });

  it('removes a watcher and stops background work if cancellation wins watch creation', async () => {
    const watchCreated = deferred<MoverLocationSubscription>();
    const subscription: MoverLocationSubscription = { remove: vi.fn() };
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    const watchForeground = vi.fn().mockReturnValue(watchCreated.promise);
    let cancelled = false;

    const pending = startMoverLocationSession(
      'DRIVER',
      {
        startBackground: vi.fn().mockResolvedValue(true),
        stopBackground,
        watchForeground,
        refreshForegroundSample: vi.fn(),
        commitSharedSample: vi.fn().mockReturnValue(true),
        publish: vi.fn(),
      },
      () => cancelled,
    );

    await vi.waitFor(() => expect(watchForeground).toHaveBeenCalledOnce());
    cancelled = true;
    watchCreated.resolve(subscription);

    await expect(pending).resolves.toEqual({ background: false });
    expect(subscription.remove).toHaveBeenCalledOnce();
    expect(stopBackground).toHaveBeenCalledOnce();
  });

  it('stops background work if foreground watcher creation fails', async () => {
    const stopBackground = vi.fn().mockResolvedValue(undefined);

    await expect(startMoverLocationSession(
      'RIDER',
      {
        startBackground: vi.fn().mockResolvedValue(true),
        stopBackground,
        watchForeground: vi.fn().mockRejectedValue(new Error('watch failed')),
        refreshForegroundSample: vi.fn(),
        commitSharedSample: vi.fn().mockReturnValue(true),
        publish: vi.fn(),
      },
      () => false,
    )).rejects.toThrow('watch failed');

    expect(stopBackground).toHaveBeenCalledOnce();
  });
});

describe('createMoverLocationController', () => {
  function dependencies({
    startBackground,
    stopBackground,
  }: {
    startBackground: MoverLocationSessionDependencies['startBackground'];
    stopBackground: MoverLocationSessionDependencies['stopBackground'];
  }): MoverLocationSessionDependencies {
    return {
      startBackground,
      stopBackground,
      watchForeground: vi.fn().mockResolvedValue({ remove: vi.fn() }),
      refreshForegroundSample: vi.fn().mockResolvedValue({ latitude: 6.91, longitude: -58.21 }),
      commitSharedSample: vi.fn().mockReturnValue(true),
      publish: vi.fn(),
    };
  }

  const principal = { generation: 1, userId: 'account-a' };
  const principalAuthority = {
    principal,
    isPrincipalCurrent: () => true,
  };

  it('finishes a pending stop before restarting the global native task', async () => {
    const controller = createMoverLocationController();
    const owner = {};
    const stopped = deferred<void>();
    let firstSessionCurrent: (() => boolean) | undefined;
    const startBackground = vi.fn(async (_kind, isSessionCurrent: () => boolean) => {
      firstSessionCurrent ??= isSessionCurrent;
      return true;
    });
    const stopBackground = vi.fn().mockReturnValue(stopped.promise);
    const deps = dependencies({ startBackground, stopBackground });

    await controller.transition(owner, {
      kind: 'DRIVER',
      ...principalAuthority,
      dependencies: deps,
    });
    expect(startBackground).toHaveBeenCalledOnce();

    const stopping = controller.transition(owner, null);
    await vi.waitFor(() => expect(stopBackground).toHaveBeenCalledOnce());
    const restarting = controller.transition(owner, {
      kind: 'DRIVER',
      ...principalAuthority,
      dependencies: deps,
    });

    expect(startBackground).toHaveBeenCalledOnce();
    expect(firstSessionCurrent?.()).toBe(false);
    stopped.resolve();
    await Promise.all([stopping, restarting]);
    expect(startBackground).toHaveBeenCalledTimes(2);
  });

  it('ignores a late cleanup from an owner replaced by another screen', async () => {
    const controller = createMoverLocationController();
    const ownerA = {};
    const ownerB = {};
    const startBackground = vi.fn().mockResolvedValue(true);
    const stopBackground = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({ startBackground, stopBackground });

    await controller.transition(ownerA, {
      kind: 'DRIVER',
      ...principalAuthority,
      dependencies: deps,
    });
    await controller.transition(ownerB, {
      kind: 'RIDER',
      ...principalAuthority,
      dependencies: deps,
    });
    expect(stopBackground).toHaveBeenCalledOnce();

    await controller.transition(ownerA, null);
    expect(stopBackground).toHaveBeenCalledOnce();
    expect(startBackground).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'the same user starts a new login generation',
      nextPrincipal: { generation: 2, userId: 'account-a' },
    },
    {
      label: 'a different user occupies the same generation',
      nextPrincipal: { generation: 1, userId: 'account-b' },
    },
  ])('makes native callbacks inert when $label', async ({ nextPrincipal }) => {
    const controller = createMoverLocationController();
    const owner = {};
    const capturedPrincipal = { generation: 1, userId: 'account-a' };
    let currentPrincipal = capturedPrincipal;
    let isNativeSessionCurrent: (() => boolean) | undefined;
    let onSample: ((sample: MoverLocationSample) => void) | undefined;
    const commitSharedSample = vi.fn().mockReturnValue(true);
    const publish = vi.fn();
    const dependencies: MoverLocationSessionDependencies = {
      startBackground: vi.fn(async (_kind, isSessionCurrent) => {
        isNativeSessionCurrent = isSessionCurrent;
        return false;
      }),
      stopBackground: vi.fn(),
      watchForeground: vi.fn(async (listener) => {
        onSample = listener;
        return { remove: vi.fn() };
      }),
      refreshForegroundSample: vi.fn().mockResolvedValue({ latitude: 6.91, longitude: -58.21 }),
      commitSharedSample,
      publish,
    };

    await controller.transition(owner, {
      kind: 'DRIVER',
      principal: capturedPrincipal,
      isPrincipalCurrent: (expected) => (
        currentPrincipal.generation === expected.generation
        && currentPrincipal.userId === expected.userId
      ),
      dependencies,
    });

    expect(isNativeSessionCurrent?.()).toBe(true);
    currentPrincipal = nextPrincipal;
    expect(isNativeSessionCurrent?.()).toBe(false);

    onSample?.({ latitude: 6.91, longitude: -58.21 });
    await Promise.resolve();
    expect(commitSharedSample).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
