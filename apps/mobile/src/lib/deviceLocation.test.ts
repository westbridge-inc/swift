import { describe, expect, it, vi } from 'vitest';
import {
  BOOT_LOCATION_MODE,
  GEORGETOWN,
  commitLiveDeviceLocation,
  createLiveDeviceLocationLease,
  grantedLocationFix,
  pickupLocationContext,
  liveLocationState,
  resolvedLocationState,
  resolveCoordinatedDeviceLocation,
  resolveDeviceLocation,
  advanceLocationAppState,
  type DeviceLocationApi,
  type DeviceLocationWriter,
  type LocationStatus,
} from './deviceLocation';

function locationApi(status: 'granted' | 'denied' | 'undetermined'): DeviceLocationApi {
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

describe('resolveDeviceLocation', () => {
  it('FO-01/SO-5: fresh boot and the role picker never request permission', async () => {
    const api = locationApi('undetermined');

    expect(BOOT_LOCATION_MODE).toBe('silent');
    await expect(resolveDeviceLocation(BOOT_LOCATION_MODE, api)).resolves.toEqual({ status: 'unknown' });
    expect(api.getForegroundPermissionsAsync).toHaveBeenCalledOnce();
    expect(api.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(api.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('requests only after an explicit in-context action and records denial', async () => {
    const api = locationApi('denied');

    await expect(resolveDeviceLocation('request', api)).resolves.toEqual({ status: 'denied' });
    expect(api.requestForegroundPermissionsAsync).toHaveBeenCalledOnce();
    expect(api.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(api.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('resolves coordinates and a best-effort Georgetown label after a grant', async () => {
    const api = locationApi('granted');

    await expect(resolveDeviceLocation('request', api)).resolves.toEqual({
      status: 'granted',
      latitude: 6.81234,
      longitude: -58.14321,
      address: 'Regent Street, Georgetown',
    });
  });

  it('keeps coordinates usable when reverse geocoding fails', async () => {
    const api = locationApi('granted');
    vi.mocked(api.reverseGeocodeAsync).mockRejectedValue(new Error('geocoder offline'));

    await expect(resolveDeviceLocation('silent', api)).resolves.toEqual({
      status: 'granted',
      latitude: 6.81234,
      longitude: -58.14321,
      address: undefined,
    });
  });

  it('rejects a non-finite OS position instead of granting an unsafe fix', async () => {
    const api = locationApi('granted');
    vi.mocked(api.getCurrentPositionAsync).mockResolvedValue({
      coords: { latitude: Number.NaN, longitude: -58.14321 },
    });

    await expect(resolveDeviceLocation('silent', api)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(api.reverseGeocodeAsync).not.toHaveBeenCalled();
  });
});

describe('resolveCoordinatedDeviceLocation', () => {
  it('discards an older granted fix when a newer explicit request observes denial', async () => {
    const oldPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const oldApi = locationApi('granted');
    vi.mocked(oldApi.getCurrentPositionAsync).mockReturnValue(oldPosition.promise);
    const newApi = locationApi('denied');
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const oldResolution = resolveCoordinatedDeviceLocation('silent', oldApi, writer);
    await Promise.resolve();
    expect(oldApi.getCurrentPositionAsync).toHaveBeenCalledOnce();

    await expect(resolveCoordinatedDeviceLocation('request', newApi, writer)).resolves.toEqual({ status: 'denied' });
    oldPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await oldResolution;

    expect(writer.setStatus).toHaveBeenNthCalledWith(1, 'resolving');
    expect(writer.setStatus).toHaveBeenNthCalledWith(2, 'resolving');
    expect(writer.setStatus).toHaveBeenNthCalledWith(3, 'denied');
    expect(writer.setStatus).toHaveBeenCalledTimes(3);
    expect(writer.setLocation).not.toHaveBeenCalled();
  });

  it('lets a genuine newer silent denial supersede a buffered explicit fix', async () => {
    const explicitPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const explicitApi = locationApi('granted');
    vi.mocked(explicitApi.getCurrentPositionAsync).mockReturnValue(explicitPosition.promise);
    const silentApi = locationApi('denied');
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const explicitResolution = resolveCoordinatedDeviceLocation('request', explicitApi, writer);
    await vi.waitFor(() => expect(explicitApi.getCurrentPositionAsync).toHaveBeenCalledOnce());
    await expect(resolveCoordinatedDeviceLocation('silent', silentApi, writer)).resolves.toEqual({
      status: 'denied',
    });
    explicitPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await expect(explicitResolution).resolves.toEqual({
      status: 'granted',
      latitude: 6.91,
      longitude: -58.21,
      address: 'Regent Street, Georgetown',
    });

    expect(writer.setStatus).toHaveBeenNthCalledWith(1, 'resolving');
    expect(writer.setStatus).toHaveBeenNthCalledWith(2, 'resolving');
    expect(writer.setStatus).toHaveBeenNthCalledWith(3, 'denied');
    expect(writer.setLocation).not.toHaveBeenCalled();
  });

  it('keeps resolving when silent A grants while newer silent B remains pending', async () => {
    const firstPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const secondPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const firstApi = locationApi('granted');
    const secondApi = locationApi('granted');
    vi.mocked(firstApi.getCurrentPositionAsync).mockReturnValue(firstPosition.promise);
    vi.mocked(secondApi.getCurrentPositionAsync).mockReturnValue(secondPosition.promise);
    let status: LocationStatus = 'unknown';
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn((next) => {
        status = next;
      }),
    };

    const first = resolveCoordinatedDeviceLocation('silent', firstApi, writer);
    await vi.waitFor(() => expect(firstApi.getCurrentPositionAsync).toHaveBeenCalledOnce());
    const second = resolveCoordinatedDeviceLocation('silent', secondApi, writer);
    await vi.waitFor(() => expect(secondApi.getCurrentPositionAsync).toHaveBeenCalledOnce());

    firstPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await expect(first).resolves.toEqual({
      status: 'granted',
      latitude: 6.91,
      longitude: -58.21,
      address: 'Regent Street, Georgetown',
    });
    expect(status).toBe('resolving');
    expect(createLiveDeviceLocationLease()).toBeNull();
    expect(writer.setLocation).not.toHaveBeenCalled();

    secondPosition.resolve({ coords: { latitude: 6.82, longitude: -58.16 } });
    await second;
    expect(writer.setLocation).toHaveBeenCalledOnce();
    expect(writer.setLocation).toHaveBeenCalledWith(6.82, -58.16, 'Regent Street, Georgetown');
  });

  it('lets a newer explicit request supersede an older explicit request', async () => {
    const oldPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const oldApi = locationApi('granted');
    vi.mocked(oldApi.getCurrentPositionAsync).mockReturnValue(oldPosition.promise);
    const newApi = locationApi('granted');
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const oldResolution = resolveCoordinatedDeviceLocation('request', oldApi, writer);
    await Promise.resolve();
    expect(oldApi.getCurrentPositionAsync).toHaveBeenCalledOnce();

    await expect(resolveCoordinatedDeviceLocation('request', newApi, writer)).resolves.toEqual({
      status: 'granted',
      latitude: 6.81234,
      longitude: -58.14321,
      address: 'Regent Street, Georgetown',
    });
    oldPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await oldResolution;

    expect(writer.setStatus).toHaveBeenCalledTimes(2);
    expect(writer.setStatus).toHaveBeenNthCalledWith(1, 'resolving');
    expect(writer.setStatus).toHaveBeenNthCalledWith(2, 'resolving');
    expect(writer.setLocation).toHaveBeenCalledOnce();
    expect(writer.setLocation).toHaveBeenCalledWith(6.81234, -58.14321, 'Regent Street, Georgetown');
  });

  it('invalidates an old granted fix immediately while a silent resume refresh is pending', async () => {
    const position = deferred<{ coords: { latitude: number; longitude: number } }>();
    const api = locationApi('granted');
    vi.mocked(api.getCurrentPositionAsync).mockReturnValue(position.promise);

    let status: LocationStatus = 'granted';
    let latitude = 6.75;
    let longitude = -58.22;
    const writer: DeviceLocationWriter = {
      setStatus: vi.fn((next: LocationStatus) => {
        status = next;
      }),
      setLocation: vi.fn((nextLatitude: number, nextLongitude: number) => {
        latitude = nextLatitude;
        longitude = nextLongitude;
        status = 'granted';
      }),
    };

    const refresh = resolveCoordinatedDeviceLocation('silent', api, writer);

    expect(status).toBe('resolving');
    expect(grantedLocationFix(latitude, longitude, status)).toBeNull();

    position.resolve({ coords: { latitude: 6.82, longitude: -58.16 } });
    await refresh;

    expect(status).toBe('granted');
    expect(grantedLocationFix(latitude, longitude, status)).toEqual({
      latitude: 6.82,
      longitude: -58.16,
    });
  });

  it('invalidates a live watcher lease while refresh is pending and after denial', async () => {
    const initialApi = locationApi('granted');
    const position = deferred<{ coords: { latitude: number; longitude: number } }>();
    const refreshApi = locationApi('granted');
    vi.mocked(refreshApi.getCurrentPositionAsync).mockReturnValue(position.promise);

    let status: LocationStatus = 'granted';
    let latitude = 6.75;
    let longitude = -58.22;
    const writer: DeviceLocationWriter = {
      setStatus: vi.fn((next: LocationStatus) => {
        status = next;
      }),
      setLocation: vi.fn((nextLatitude: number, nextLongitude: number) => {
        latitude = nextLatitude;
        longitude = nextLongitude;
        status = 'granted';
      }),
    };

    await resolveCoordinatedDeviceLocation('silent', initialApi, writer);
    const lease = createLiveDeviceLocationLease();
    expect(lease).not.toBeNull();

    const refresh = resolveCoordinatedDeviceLocation('silent', refreshApi, writer);
    expect(status).toBe('resolving');

    const liveWriter = { setLiveLocation: writer.setLocation };
    expect(commitLiveDeviceLocation(lease!, liveWriter, 6.93, -58.31)).toBe(false);
    expect(status).toBe('resolving');

    position.reject(new Error('permission was revoked during refresh'));
    await expect(refresh).resolves.toEqual({ status: 'unavailable' });

    expect(status).toBe('unavailable');
    expect(commitLiveDeviceLocation(lease!, liveWriter, 6.94, -58.32)).toBe(false);
    expect({ latitude, longitude }).toEqual({ latitude: 6.81234, longitude: -58.14321 });
  });
});

describe('advanceLocationAppState', () => {
  it('ignores permission-sheet inactive-to-active transitions', () => {
    const inactive = advanceLocationAppState(false, 'inactive');
    expect(advanceLocationAppState(inactive.wasBackgrounded, 'active')).toEqual({
      wasBackgrounded: false,
      shouldRefresh: false,
    });
  });

  it('retains background history through iOS inactive and refreshes on active', () => {
    const background = advanceLocationAppState(false, 'background');
    const inactive = advanceLocationAppState(background.wasBackgrounded, 'inactive');
    expect(advanceLocationAppState(inactive.wasBackgrounded, 'active')).toEqual({
      wasBackgrounded: false,
      shouldRefresh: true,
    });
  });
});

describe('location store payloads', () => {
  it('clears an old street label when reverse geocoding fails at a new coordinate', () => {
    const previous = { address: 'Old Street, Georgetown' };
    expect({
      ...previous,
      ...resolvedLocationState(6.91, -58.21, undefined),
    }).toMatchObject({ latitude: 6.91, longitude: -58.21, address: null });
  });

  it('does not attach a previous label to continuous mover coordinates', () => {
    const previous = { address: 'Old Street, Georgetown' };
    expect({
      ...previous,
      ...liveLocationState(6.92, -58.22),
    }).toMatchObject({ latitude: 6.92, longitude: -58.22, address: null });
  });
});

describe('grantedLocationFix', () => {
  it('does not treat persisted coordinates as live after permission is denied', () => {
    expect(grantedLocationFix(6.82, -58.16, 'denied')).toBeNull();
  });

  it('does not treat persisted coordinates as live while permission is unknown', () => {
    expect(grantedLocationFix(6.82, -58.16, 'unknown')).toBeNull();
  });

  it('requires finite coordinates even when permission is granted', () => {
    expect(grantedLocationFix(Number.NaN, -58.16, 'granted')).toBeNull();
    expect(grantedLocationFix(6.82, Number.POSITIVE_INFINITY, 'granted')).toBeNull();
  });

  it('returns the live coordinates only after a granted finite fix', () => {
    expect(grantedLocationFix(6.82, -58.16, 'granted')).toEqual({
      latitude: 6.82,
      longitude: -58.16,
    });
  });
});

describe('pickupLocationContext', () => {
  it('R-10: denial keeps the Georgetown map and manual pin path working', () => {
    expect(pickupLocationContext(null, null, 'denied')).toEqual({
      center: GEORGETOWN,
      devicePickup: null,
      showUserLocation: false,
      showPrimer: true,
      manualPinAvailable: true,
    });
  });

  it('uses persisted coordinates only as a map center until permission is confirmed', () => {
    expect(pickupLocationContext(6.82, -58.16, 'unknown')).toEqual({
      center: { latitude: 6.82, longitude: -58.16, label: 'Last known location' },
      devicePickup: null,
      showUserLocation: false,
      showPrimer: true,
      manualPinAvailable: true,
    });
  });

  it('uses a granted fix as the automatic pickup and still preserves manual override', () => {
    expect(pickupLocationContext(6.82, -58.16, 'granted')).toEqual({
      center: { latitude: 6.82, longitude: -58.16, label: 'Current location' },
      devicePickup: { latitude: 6.82, longitude: -58.16, label: 'Current location' },
      showUserLocation: true,
      showPrimer: false,
      manualPinAvailable: true,
    });
  });
});
