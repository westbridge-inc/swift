import { countryFromPhone } from '../../utils/phone-country';

/**
 * Public V1 launch authority.
 *
 * CountryConfig keeps future market policy so expansion does not require a
 * data-model rewrite. It does not, by itself, make a market public: that is a
 * deliberate product release decision recorded here and enforced at every
 * unauthenticated signup boundary.
 */
export const PUBLIC_LAUNCH_COUNTRY_CODES = ['GY'] as const;

export type PublicLaunchCountryCode = (typeof PUBLIC_LAUNCH_COUNTRY_CODES)[number];

export function isPublicLaunchCountry(code: string | null | undefined): code is PublicLaunchCountryCode {
  return PUBLIC_LAUNCH_COUNTRY_CODES.some((launchCode) => launchCode === code?.toUpperCase());
}

export function publicLaunchCountryFromPhone(phone: string): PublicLaunchCountryCode | null {
  const country = countryFromPhone(phone);
  return isPublicLaunchCountry(country) ? country : null;
}
