import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { DEFAULT_COUNTRY } from '../lib/markets';

/**
 * V1 is Guyana-only. Keep every entry path on the one released market and
 * repair stale pre-launch persisted country data without requesting location.
 */
export function useCustomerCountry() {
  const intent = useAuthStore((s) => s.intent);
  const countryCode = useAuthStore((s) => s.countryCode);
  const dialCode = useAuthStore((s) => s.dialCode);
  const currencyCode = useAuthStore((s) => s.currencyCode);
  const setCountry = useAuthStore((s) => s.setCountry);

  useEffect(() => {
    if (
      intent &&
      (countryCode !== DEFAULT_COUNTRY.code ||
        dialCode !== DEFAULT_COUNTRY.dialCode ||
        currencyCode !== DEFAULT_COUNTRY.currencyCode)
    ) {
      setCountry(DEFAULT_COUNTRY);
    }
  }, [intent, countryCode, dialCode, currencyCode, setCountry]);
}
