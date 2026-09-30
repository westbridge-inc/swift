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

/** A box on the map in degrees: latitudes south to north, longitudes west to east. */
export interface MarketBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

/**
 * [Q8] Where each launch market is on the map, as a coarse country box. A
 * store pin is where riders and customers are sent and where "nearby" is
 * measured from, so a pin in no launch market is refused: a phone that signed
 * up abroad, a 0,0 fix, a swapped or sign-flipped coordinate, garbage.
 *
 * [DS269 F2] It is a box, not the border and not a coastline test. Guyana
 * lies between latitudes 1 and 9 degrees north and longitudes 56 and 62
 * degrees west, and the box is exactly that, so it also holds open sea off the
 * coast (7.2 N 57.6 W) and towns across every border: Boa Vista in Brazil,
 * Santa Elena de Uairen in Venezuela, Nieuw Nickerie in Suriname. A pin there
 * is accepted. What the box guarantees is that no real Guyana store is
 * refused, border towns included (Lethem on the Takutu, Corriverton on the
 * Courantyne). The exact spot is the owner confirming it on the map, and the
 * store review.
 *
 * Keyed by the launch list itself: a market added to it without a box stops
 * this Record compiling.
 */
export const LAUNCH_MARKET_BOUNDS: Readonly<Record<PublicLaunchCountryCode, MarketBounds>> = {
  GY: { south: 1, north: 9, west: -62, east: -56 },
};

/** The launch market a point lies in, or null when it lies in none (a NaN
 *  fails every comparison below, so it lies in none). */
export function launchMarketAt(latitude: number, longitude: number): PublicLaunchCountryCode | null {
  for (const code of PUBLIC_LAUNCH_COUNTRY_CODES) {
    const box = LAUNCH_MARKET_BOUNDS[code];
    if (latitude >= box.south && latitude <= box.north && longitude >= box.west && longitude <= box.east) return code;
  }
  return null;
}
