import { useEffect } from 'react';
import * as Location from 'expo-location';
import { authApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { DEFAULT_COUNTRY } from '../lib/markets';

/**
 * Customers skip the country picker (spec: pick role → straight to browsing).
 * Two jobs, both customer-only — earners still pick explicitly (it drives their
 * signup + pricing):
 *   1. Seed a sensible default so the market/currency is never empty when Home
 *      mounts. (The primary seed is synchronous in RolePicker; this is a
 *      fallback for other ways intent becomes 'customer', e.g. after login.)
 *   2. Refine to the device's actual market via the OS geocoder (no API key),
 *      matching the ISO country to a live CountryConfig. Best-effort: on denied
 *      location / no match / any error we keep the default.
 */
export function useCustomerCountry() {
  const intent = useAuthStore((s) => s.intent);
  const countryCode = useAuthStore((s) => s.countryCode);
  const setCountry = useAuthStore((s) => s.setCountry);

  useEffect(() => {
    if (intent === 'customer' && !countryCode) setCountry(DEFAULT_COUNTRY);
  }, [intent, countryCode, setCountry]);

  useEffect(() => {
    if (intent !== 'customer') return;
    let cancelled = false;
    void (async () => {
      try {
        // Don't prompt here — onboarding already asked. Only refine if allowed.
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
        const [place] = await Location.reverseGeocodeAsync({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        const iso = place?.isoCountryCode?.toUpperCase();
        if (!iso || cancelled) return;
        const markets: any[] = (await authApi.countries()).data?.data ?? [];
        const m = markets.find((x) => x.code?.toUpperCase() === iso);
        // Only switch to a real, different market — an unsupported country keeps
        // the default rather than stranding the customer on an empty market.
        if (m && m.code !== useAuthStore.getState().countryCode && !cancelled) {
          setCountry({
            code: m.code,
            dialCode: m.dialCode,
            currencyCode: m.currencyCode,
            currencySymbol: m.currencySymbol,
          });
        }
      } catch {
        // keep the default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [intent, setCountry]);
}
