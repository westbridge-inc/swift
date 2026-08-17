import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { useLocationStore } from '../stores/locationStore';
import {
  BOOT_LOCATION_MODE,
  resolveCoordinatedDeviceLocation,
  advanceLocationAppState,
  type DeviceLocationApi,
  type LocationResolutionMode,
} from '../lib/deviceLocation';

export { GEORGETOWN } from '../lib/deviceLocation';

const deviceLocationApi: DeviceLocationApi = {
  getForegroundPermissionsAsync: Location.getForegroundPermissionsAsync,
  requestForegroundPermissionsAsync: Location.requestForegroundPermissionsAsync,
  getCurrentPositionAsync: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
  reverseGeocodeAsync: Location.reverseGeocodeAsync,
};

/**
 * Silently refreshes an already-granted device position at boot. The OS request
 * exists only behind `resolve`, which an in-context primer calls after a user
 * taps it [first-open SO-5]. Returning from Settings silently rechecks the grant.
 */
export function useDeviceLocation({ refreshOnMount = true }: { refreshOnMount?: boolean } = {}) {
  const setLocation = useLocationStore((s) => s.setLocation);
  const setStatus = useLocationStore((s) => s.setStatus);

  const run = useCallback(async (mode: LocationResolutionMode) => {
    return resolveCoordinatedDeviceLocation(mode, deviceLocationApi, { setLocation, setStatus });
  }, [setLocation, setStatus]);

  const refresh = useCallback(() => run(BOOT_LOCATION_MODE), [run]);
  const resolve = useCallback(() => run('request'), [run]);

  useEffect(() => {
    if (!refreshOnMount) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshWithRetry = async (attempt = 0) => {
      const result = await refresh();
      // A granted permission can still yield a transient no-fix result while
      // GPS wakes after resume. The live lease was conservatively revoked at
      // refresh start, so retry promptly instead of leaving an active trip's
      // stream stopped forever. Confirmed denial never retries.
      if (
        !cancelled
        && result.status === 'unavailable'
        && AppState.currentState === 'active'
        && attempt < 3
      ) {
        retryTimer = setTimeout(() => void refreshWithRetry(attempt + 1), 2_000 * (attempt + 1));
      }
    };

    void refreshWithRetry();
    let wasBackgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', (next) => {
      const transition = advanceLocationAppState(wasBackgrounded, next);
      wasBackgrounded = transition.wasBackgrounded;
      if (transition.shouldRefresh) void refreshWithRetry();
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      subscription.remove();
    };
  }, [refresh, refreshOnMount]);

  return { refresh, resolve };
}
