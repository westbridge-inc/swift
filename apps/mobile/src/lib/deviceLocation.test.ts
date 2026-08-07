import { describe, expect, it, vi } from 'vitest';
import {
  BOOT_LOCATION_MODE,
  GEORGETOWN,
  grantedLocationFix,
  pickupLocationContext,
  resolveCoordinatedDeviceLocation,
  resolveDeviceLocation,
  type DeviceLocationApi,
  type DeviceLocationWriter,
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
    expect(writer.setStatus).toHaveBeenNthCalledWith(2, 'denied');
    expect(writer.setStatus).toHaveBeenCalledTimes(2);
    expect(writer.setLocation).not.toHaveBeenCalled();
  });

  it('lets a newer silent denial invalidate an explicit grant that is still resolving', async () => {
    const explicitPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const explicitApi = locationApi('granted');
    vi.mocked(explicitApi.getCurrentPositionAsync).mockReturnValue(explicitPosition.promise);
    const silentApi = locationApi('denied');
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const explicitResolution = resolveCoordinatedDeviceLocation('request', explicitApi, writer);
    await Promise.resolve();
    expect(explicitApi.getCurrentPositionAsync).toHaveBeenCalledOnce();

    await expect(resolveCoordinatedDeviceLocation('silent', silentApi, writer)).resolves.toEqual({
      status: 'denied',
    });
    expect(writer.setStatus).toHaveBeenNthCalledWith(1, 'resolving');
    expect(writer.setStatus).toHaveBeenNthCalledWith(2, 'denied');

    explicitPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await expect(explicitResolution).resolves.toEqual({
      status: 'granted',
      latitude: 6.91,
      longitude: -58.21,
      address: 'Regent Street, Georgetown',
    });

    expect(writer.setStatus).toHaveBeenCalledTimes(2);
    expect(writer.setLocation).not.toHaveBeenCalled();
  });

  it('lets a newer reliable silent grant supersede an explicit fix that is still resolving', async () => {
    const explicitPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const explicitApi = locationApi('granted');
    vi.mocked(explicitApi.getCurrentPositionAsync).mockReturnValue(explicitPosition.promise);
    const silentApi = locationApi('granted');
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const explicitResolution = resolveCoordinatedDeviceLocation('request', explicitApi, writer);
    await Promise.resolve();
    expect(explicitApi.getCurrentPositionAsync).toHaveBeenCalledOnce();

    await expect(resolveCoordinatedDeviceLocation('silent', silentApi, writer)).resolves.toEqual({
      status: 'granted',
      latitude: 6.81234,
      longitude: -58.14321,
      address: 'Regent Street, Georgetown',
    });
    expect(writer.setLocation).toHaveBeenCalledOnce();
    expect(writer.setLocation).toHaveBeenCalledWith(6.81234, -58.14321, 'Regent Street, Georgetown');

    explicitPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await explicitResolution;

    expect(writer.setStatus).toHaveBeenCalledOnce();
    expect(writer.setStatus).toHaveBeenCalledWith('resolving');
    expect(writer.setLocation).toHaveBeenCalledOnce();
  });

  it('keeps an explicit grant authoritative when a newer silent refresh returns unknown first', async () => {
    const explicitPermission = deferred<{ status: string }>();
    const explicitApi = locationApi('granted');
    vi.mocked(explicitApi.requestForegroundPermissionsAsync).mockReturnValue(explicitPermission.promise);
    const silentApi = locationApi('undetermined');
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const explicitResolution = resolveCoordinatedDeviceLocation('request', explicitApi, writer);
    await expect(resolveCoordinatedDeviceLocation('silent', silentApi, writer)).resolves.toEqual({
      status: 'unknown',
    });
    explicitPermission.resolve({ status: 'granted' });
    await expect(explicitResolution).resolves.toEqual({
      status: 'granted',
      latitude: 6.81234,
      longitude: -58.14321,
      address: 'Regent Street, Georgetown',
    });

    expect(writer.setStatus).toHaveBeenCalledOnce();
    expect(writer.setStatus).toHaveBeenCalledWith('resolving');
    expect(writer.setLocation).toHaveBeenCalledOnce();
    expect(writer.setLocation).toHaveBeenCalledWith(6.81234, -58.14321, 'Regent Street, Georgetown');
  });

  it('keeps an explicit grant when a newer silent refresh hangs and later becomes unavailable', async () => {
    const explicitPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const explicitApi = locationApi('granted');
    vi.mocked(explicitApi.getCurrentPositionAsync).mockReturnValue(explicitPosition.promise);
    const silentPosition = deferred<{ coords: { latitude: number; longitude: number } }>();
    const silentApi = locationApi('granted');
    vi.mocked(silentApi.getCurrentPositionAsync).mockReturnValue(silentPosition.promise);
    const writer: DeviceLocationWriter = {
      setLocation: vi.fn(),
      setStatus: vi.fn(),
    };

    const explicitResolution = resolveCoordinatedDeviceLocation('request', explicitApi, writer);
    await Promise.resolve();
    expect(explicitApi.getCurrentPositionAsync).toHaveBeenCalledOnce();

    const silentResolution = resolveCoordinatedDeviceLocation('silent', silentApi, writer);
    await Promise.resolve();
    expect(silentApi.getCurrentPositionAsync).toHaveBeenCalledOnce();

    explicitPosition.resolve({ coords: { latitude: 6.91, longitude: -58.21 } });
    await expect(explicitResolution).resolves.toEqual({
      status: 'granted',
      latitude: 6.91,
      longitude: -58.21,
      address: 'Regent Street, Georgetown',
    });
    expect(writer.setLocation).toHaveBeenCalledOnce();
    expect(writer.setLocation).toHaveBeenCalledWith(6.91, -58.21, 'Regent Street, Georgetown');

    silentPosition.reject(new Error('foreground fix unavailable'));
    await expect(silentResolution).resolves.toEqual({ status: 'unavailable' });

    expect(writer.setStatus).toHaveBeenCalledOnce();
    expect(writer.setStatus).toHaveBeenCalledWith('resolving');
    expect(writer.setLocation).toHaveBeenCalledOnce();
    expect(writer.setLocation).toHaveBeenCalledWith(6.91, -58.21, 'Regent Street, Georgetown');
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
