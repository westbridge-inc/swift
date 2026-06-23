import { useCallback, useEffect } from 'react';
import * as Location from 'expo-location';
import { useLocationStore } from '../stores/locationStore';

// Default fallback centre (Georgetown) — mirrors LocationPickerScreen so manual
// pick and auto-detect agree on the same baseline.
export const GEORGETOWN = { latitude: 6.8013, longitude: -58.1551, label: 'Georgetown' };

/**
 * Resolves the device's current position (with foreground permission),
 * reverse-geocodes a human label using the OS geocoder (no API key), and writes
 * it into locationStore. Never throws: on denial it sets status 'denied', on any
 * other failure 'unavailable', so the UI can surface an actionable fallback
 * instead of a dead string. Returns `resolve` for manual retry (e.g. a "Try
 * again" button after the user enables location in Settings).
 */
export function useDeviceLocation() {
  const setLocation = useLocationStore((s) => s.setLocation);
  const setStatus = useLocationStore((s) => s.setStatus);

  const resolve = useCallback(async () => {
    try {
      setStatus('resolving');
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setStatus('denied');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;

      let label: string | undefined;
      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (place) {
          label =
            [place.name ?? place.street, place.city ?? place.subregion].filter(Boolean).join(', ') ||
            undefined;
        }
      } catch {
        // Reverse geocode is best-effort; coordinates alone are enough to proceed.
      }

      setLocation(latitude, longitude, label);
    } catch {
      setStatus('unavailable');
    }
  }, [setLocation, setStatus]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  return { resolve };
}
