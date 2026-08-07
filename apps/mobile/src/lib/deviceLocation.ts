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

/**
 * Every useDeviceLocation hook writes to the same location store, so operation
 * ordering must also be shared. A per-hook flag cannot arbitrate root AppState,
 * Taxi, Courier and Nearby resolutions that overlap one another.
 */
function createLocationResolutionCoordinator() {
  let nextSequence = 0;
  let latestAuthoritySequence = 0;
  const activeRequestSequences = new Set<number>();

  return {
    begin(mode: LocationResolutionMode) {
      const sequence = ++nextSequence;
      const beganDuringRequest = mode === 'silent' && activeRequestSequences.size > 0;

      // Explicit user actions reserve authority immediately, so any work that
      // started earlier is stale even while the OS request is still pending.
      if (mode === 'request') {
        latestAuthoritySequence = sequence;
        activeRequestSequences.add(sequence);
      }

      return {
        claim(result: DeviceLocationResolution) {
          if (mode === 'request') return sequence === latestAuthoritySequence;

          const isConfirmedPermissionState = result.status === 'granted' || result.status === 'denied';

          // A transient foreground result must not strand or overwrite an
          // explicit request it overlapped. A confirmed grant or revocation is
          // authoritative and may supersede older work.
          if (!isConfirmedPermissionState && beganDuringRequest) return false;
          if (sequence < latestAuthoritySequence) return false;

          latestAuthoritySequence = sequence;
          return true;
        },
        finish: () => {
          if (mode === 'request') activeRequestSequences.delete(sequence);
        },
      };
    },
  };
}

const sharedLocationResolutionCoordinator = createLocationResolutionCoordinator();

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
    if (mode === 'request') writer.setStatus('resolving');

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
