export type LocationStatus = 'unknown' | 'resolving' | 'granted' | 'denied' | 'unavailable';
export type LocationResolutionMode = 'silent' | 'request';

export const BOOT_LOCATION_MODE: LocationResolutionMode = 'silent';

export const GEORGETOWN = {
  latitude: 6.8013,
  longitude: -58.1551,
  label: 'Georgetown',
} as const;

export interface DeviceLocationApi {
  getForegroundPermissionsAsync: () => Promise<{ status: string }>;
  requestForegroundPermissionsAsync: () => Promise<{ status: string }>;
  getCurrentPositionAsync: () => Promise<{ coords: { latitude: number; longitude: number } }>;
  reverseGeocodeAsync: (coordinate: { latitude: number; longitude: number }) => Promise<
    Array<{
      name?: string | null;
      street?: string | null;
      city?: string | null;
      subregion?: string | null;
    }>
  >;
}

export type DeviceLocationResolution =
  | { status: 'unknown' | 'denied' | 'unavailable' }
  | { status: 'granted'; latitude: number; longitude: number; address?: string };

export interface DeviceLocationWriter {
  setLocation: (latitude: number, longitude: number, address?: string) => void;
  setStatus: (status: LocationStatus) => void;
}

export interface LiveDeviceLocationWriter {
  setLiveLocation: (latitude: number, longitude: number) => void;
}

export interface LiveDeviceLocationLease {
  readonly generation: number;
}

export function resolvedLocationState(
  latitude: number,
  longitude: number,
  address?: string,
) {
  return {
    latitude,
    longitude,
    address: address ?? null,
    status: 'granted' as const,
  };
}

export function liveLocationState(latitude: number, longitude: number) {
  return {
    latitude,
    longitude,
    address: null,
    status: 'granted' as const,
  };
}

/**
 * Every useDeviceLocation hook writes to the same location store, so operation
 * ordering must also be shared. A per-hook flag cannot arbitrate root AppState,
 * Taxi, Courier and Nearby resolutions that overlap one another.
 */
function createLocationResolutionCoordinator() {
  let nextSequence = 0;
  let latestStartedSequence = 0;
  let liveGeneration = 0;
  let permissionState: LocationStatus = 'unknown';

  return {
    begin(_mode: LocationResolutionMode) {
      const sequence = ++nextSequence;
      latestStartedSequence = sequence;

      // Any permission refresh immediately revokes existing watcher authority.
      // A fresh lease can be issued only after a coordinated grant commits.
      liveGeneration += 1;
      permissionState = 'resolving';

      return {
        claim(result: DeviceLocationResolution) {
          // Among operations that actually start, last-start-wins. In
          // particular, an older grant cannot restore watcher authority while
          // a newer silent refresh is still resolving.
          if (sequence !== latestStartedSequence) return false;
          permissionState = result.status;
          return true;
        },
        finish: () => {},
      };
    },
    createLiveLease(): LiveDeviceLocationLease | null {
      return permissionState === 'granted' ? { generation: liveGeneration } : null;
    },
    acceptsLiveLease(lease: LiveDeviceLocationLease) {
      return permissionState === 'granted' && lease.generation === liveGeneration;
    },
  };
}

const sharedLocationResolutionCoordinator = createLocationResolutionCoordinator();

/**
 * Commits a coordinate emitted by an already-authorized live watcher through
 * the same authority clock used by one-shot permission resolutions.
 */
export function commitLiveDeviceLocation(
  lease: LiveDeviceLocationLease,
  writer: LiveDeviceLocationWriter,
  latitude: number,
  longitude: number,
) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (!sharedLocationResolutionCoordinator.acceptsLiveLease(lease)) return false;
  writer.setLiveLocation(latitude, longitude);
  return true;
}

export function createLiveDeviceLocationLease() {
  return sharedLocationResolutionCoordinator.createLiveLease();
}

export function isLiveDeviceLocationLeaseValid(lease: LiveDeviceLocationLease) {
  return sharedLocationResolutionCoordinator.acceptsLiveLease(lease);
}

/** Permission sheets cause inactive -> active. iOS may foreground through
 * background -> inactive -> active, so retain a sticky background marker until
 * active rather than comparing only the adjacent pair. */
export function advanceLocationAppState(wasBackgrounded: boolean, next: string) {
  if (next === 'background') {
    return { wasBackgrounded: true, shouldRefresh: false };
  }
  if (next === 'active') {
    return { wasBackgrounded: false, shouldRefresh: wasBackgrounded };
  }
  return { wasBackgrounded, shouldRefresh: false };
}

/**
 * Coordinates in the persisted store are only a last-known map center. They
 * become a live device fix—and may influence proximity results—only after the
 * current permission check is granted and both values are finite.
 */
export function grantedLocationFix(
  latitude: number | null,
  longitude: number | null,
  status: LocationStatus,
) {
  if (status !== 'granted' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude: latitude as number,
    longitude: longitude as number,
  };
}

/**
 * The one OS-location policy. `silent` only inspects an existing grant and is
 * safe at boot; `request` is reserved for an explicit, in-context user action.
 */
export async function resolveDeviceLocation(
  mode: LocationResolutionMode,
  api: DeviceLocationApi,
): Promise<DeviceLocationResolution> {
  try {
    const permission = mode === 'request'
      ? await api.requestForegroundPermissionsAsync()
      : await api.getForegroundPermissionsAsync();

    if (permission.status !== 'granted') {
      return {
        status: mode === 'silent' && permission.status === 'undetermined' ? 'unknown' : 'denied',
      };
    }

    const position = await api.getCurrentPositionAsync();
    const { latitude, longitude } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { status: 'unavailable' };
    }
    let address: string | undefined;

    try {
      const [place] = await api.reverseGeocodeAsync({ latitude, longitude });
      if (place) {
        address = [place.name ?? place.street, place.city ?? place.subregion].filter(Boolean).join(', ') || undefined;
      }
    } catch {
      // Coordinates are sufficient; the OS label is a best-effort enhancement.
    }

    return { status: 'granted', latitude, longitude, address };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Resolves location and commits only after claiming shared write authority.
 * Explicit requests reserve authority when they start. A newer silent grant or
 * denial is confirmed OS state and may supersede older work, while transient
 * silent results cannot supersede an explicit request they overlapped. Results
 * are still returned without commit authority so callers retain the same API.
 */
export async function resolveCoordinatedDeviceLocation(
  mode: LocationResolutionMode,
  api: DeviceLocationApi,
  writer: DeviceLocationWriter,
): Promise<DeviceLocationResolution> {
  const operation = sharedLocationResolutionCoordinator.begin(mode);

  try {
    // A persisted fix remains useful map context, but it must stop being an
    // automatic pickup/demand/SOS coordinate as soon as any refresh begins.
    // This closes the warm-resume window where an old granted fix otherwise
    // stayed authoritative while getCurrentPositionAsync was still pending.
    writer.setStatus('resolving');

    const result = await resolveDeviceLocation(mode, api);
    if (!operation.claim(result)) return result;

    if (result.status === 'granted') {
      writer.setLocation(result.latitude, result.longitude, result.address);
    } else {
      writer.setStatus(result.status);
    }

    return result;
  } finally {
    operation.finish();
  }
}

export function pickupLocationContext(
  latitude: number | null,
  longitude: number | null,
  status: LocationStatus,
) {
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const grantedFix = grantedLocationFix(latitude, longitude, status);
  const center = hasCoordinates
    ? { latitude: latitude as number, longitude: longitude as number, label: status === 'granted' ? 'Current location' : 'Last known location' }
    : GEORGETOWN;

  return {
    center,
    devicePickup: grantedFix ? { ...grantedFix, label: 'Current location' } : null,
    showUserLocation: grantedFix !== null,
    showPrimer: grantedFix === null,
    // Search, saved places and the fixed-center pin remain available in every
    // permission state; denial is never a dead end.
    manualPinAvailable: true,
  };
}
