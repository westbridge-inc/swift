import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { useLocationStore } from '../stores/locationStore';
import {
  BOOT_LOCATION_MODE,
  resolveCoordinatedDeviceLocation,
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
    void refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh, refreshOnMount]);

  return { refresh, resolve };
}
