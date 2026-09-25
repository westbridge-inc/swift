import { GEORGETOWN } from './deviceLocation';
import type { BusinessSetupType } from '../stores/businessSetupDraft';

// ---------------------------------------------------------------------------
// [Q8] The store pin. Owner report: "they can't just use the location they're
// registering from for the store." List-your-business used to send the phone's
// GPS as the store's coordinates, and people sign up from home, an office or a
// car. The pin is where every rider and customer is sent and what decides which
// shoppers see the store as "nearby", so it is now placed on purpose: the owner
// puts it on the entrance on a map and confirms it. The phone's position is only
// ever a place for the map to START, and nothing is a pin until it is confirmed.
// ---------------------------------------------------------------------------

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** A pin its owner confirmed on the map. `address` is the line the map showed
 *  under the pin at that moment, or null when the phone could not name it. */
export interface StorePin extends LatLng {
  address: string | null;
}

/** Where the map opened: said on the picker, so the owner knows what they are looking at. */
export type StorePinStartBasis = 'current' | 'address' | 'device' | 'market';

export interface StorePinStart extends LatLng {
  basis: StorePinStartBasis;
}

const isPoint = (p: LatLng | null | undefined): p is LatLng =>
  p != null && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);

/**
 * Where the map opens, first match wins:
 *   1. the pin already placed (the owner is adjusting it);
 *   2. the address the owner typed, when the phone can find it;
 *   3. where the phone is, as a SUGGESTION only;
 *   4. the market centre.
 * None of these is a pin. The owner still moves the map and confirms.
 */
export function storePinStart(from: {
  current?: LatLng | null;
  geocoded?: LatLng | null;
  device?: LatLng | null;
}): StorePinStart {
  const pick = (p: LatLng, basis: StorePinStartBasis): StorePinStart => ({ latitude: p.latitude, longitude: p.longitude, basis });
  if (isPoint(from.current)) return pick(from.current, 'current');
  if (isPoint(from.geocoded)) return pick(from.geocoded, 'address');
  if (isPoint(from.device)) return pick(from.device, 'device');
  return pick(GEORGETOWN, 'market');
}

/** Has the map been moved off where it opened? A few metres of float noise is not a move. */
export function storePinMoved(start: LatLng, centre: LatLng): boolean {
  return Math.abs(centre.latitude - start.latitude) > 1e-4 || Math.abs(centre.longitude - start.longitude) > 1e-4;
}

/**
 * [WR-015's rule, as the address picker has it] The market centre is a place to
 * start looking, never a store: confirmable only once the owner has moved the
 * map. Every other start is a real place the owner can see and confirm as is.
 */
export function storePinConfirmable(basis: StorePinStartBasis, moved: boolean): boolean {
  return basis !== 'market' || moved;
}

export const STORE_PIN_COPY = {
  instruction: 'Put the pin on your store’s entrance.',
  consequence: 'Riders and customers will come here.',
  confirm: 'Confirm store location',
  moveFirst: 'Move the map to your store',
  findingAddress: 'Finding the address…',
} as const;

/** One truthful line about where the map started. */
export function storePinStartLine(basis: StorePinStartBasis, addressNotFound: boolean): string {
  const missed = addressNotFound ? 'We couldn’t find that address on the map. ' : '';
  switch (basis) {
    case 'current':
      return 'This is where your store’s pin is now.';
    case 'address':
      return 'Starting at the address you typed.';
    case 'device':
      return `${missed}Starting where your phone is. If you’re not at the store, move the pin.`;
    case 'market':
      return `${missed}Starting in ${GEORGETOWN.label}. Move the map to your store.`;
  }
}

/** The parts of one reverse-geocode result a pin's address line is made from. */
export interface StorePinPlace {
  name?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  city?: string | null;
  district?: string | null;
  subregion?: string | null;
}

/** The phone's own geocoder (expo-location): no API key and no paid provider. */
export interface StorePinGeocoder {
  geocodeAsync: (address: string) => Promise<LatLng[]>;
  reverseGeocodeAsync: (point: LatLng) => Promise<StorePinPlace[]>;
}

/** V1 serves Guyana only (the API's launch-market authority), so the typed
 *  address is looked up there and not in a same-named town abroad. */
const MARKET_COUNTRY = 'Guyana';
const GEOCODE_TIMEOUT_MS = 4000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The typed street address as a point. Best effort: too little typed, nothing
 * found, an error or a slow answer all mean null, and the map starts from the
 * next choice instead. Never a reason to keep the owner waiting.
 */
export async function geocodeStoreAddress(
  geocoder: Pick<StorePinGeocoder, 'geocodeAsync'>,
  line: string,
  city: string,
  timeoutMs = GEOCODE_TIMEOUT_MS,
): Promise<LatLng | null> {
  const street = line.trim();
  if (street.length < 3) return null;
  const query = [street, city.trim(), MARKET_COUNTRY].filter(Boolean).join(', ');
  try {
    const found = await withTimeout(geocoder.geocodeAsync(query), timeoutMs);
    const hit = (found ?? []).find(isPoint);
    return hit ? { latitude: hit.latitude, longitude: hit.longitude } : null;
  } catch {
    return null;
  }
}

/** "12 Regent St, Georgetown" from one reverse-geocode result, or null. */
export function storePinAddressLine(place: StorePinPlace | undefined): string | null {
  if (!place) return null;
  const street = place.name || [place.streetNumber, place.street].filter(Boolean).join(' ') || null;
  const town = place.city || place.district || place.subregion || null;
  return [street, town].filter(Boolean).join(', ') || null;
}

/** The address line under a pin. Best effort, exactly like the geocode above. */
export async function reverseGeocodeStorePin(
  geocoder: Pick<StorePinGeocoder, 'reverseGeocodeAsync'>,
  point: LatLng,
  timeoutMs = GEOCODE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const found = await withTimeout(geocoder.reverseGeocodeAsync(point), timeoutMs);
    return storePinAddressLine(found?.[0]);
  } catch {
    return null;
  }
}

/** A value is a confirmed pin only with real coordinates. */
export function confirmedStorePin(pin: StorePin | null | undefined): StorePin | null {
  return pin != null && isPoint(pin) ? pin : null;
}

/** What the List-your-business form holds (stores/businessSetupDraft). */
export interface BusinessSetupFields {
  name: string;
  type: BusinessSetupType;
  phone: string;
  addr: string;
  city: string;
  agree: boolean;
  pin: StorePin | null;
}

/**
 * [#947's grammar] The first thing the form still needs, in the order it asks
 * for them, or null when the store can be created. The fee comes before all of
 * these and stays with the screen (quoteGate). The pin comes after the address
 * because the map starts from the address.
 */
export function businessSetupBlocker(form: BusinessSetupFields): string | null {
  if (form.name.trim().length < 2) return 'Name your business';
  if (form.phone.trim().length < 5) return 'Add the business phone';
  if (form.addr.trim().length < 3) return 'Add the street address';
  if (form.city.trim().length < 2) return 'Add the city';
  if (!confirmedStorePin(form.pin)) return 'Place your store on the map';
  if (!form.agree) return 'Agree to the Business Agreement first';
  return null;
}

/**
 * The business POST /partner/become is sent, or null while the form is not
 * ready. Its coordinates are the pin the owner confirmed and nothing else: the
 * phone's position has no way in.
 */
export function vendorBusinessPayload(form: BusinessSetupFields) {
  const pin = confirmedStorePin(form.pin);
  if (!pin || businessSetupBlocker(form) !== null) return null;
  return {
    name: form.name.trim(),
    vendorType: form.type,
    phone: form.phone.trim(),
    addressLine1: form.addr.trim(),
    city: form.city.trim(),
    latitude: pin.latitude,
    longitude: pin.longitude,
  };
}

/** The API refuses a pin outside the market with this code (modules/vendor/store-pin). */
export const STORE_PIN_OUT_OF_MARKET = 'STORE_PIN_OUT_OF_MARKET';

/** What the form says when the store could not be created. A pin the server
 *  refused says so in the server's words: "try again" would not help, moving the pin does. */
export function storeCreateErrorCopy(error: unknown): string {
  const body = (error as { response?: { data?: { error?: { code?: string; message?: string } } } } | null)?.response?.data?.error;
  if (body?.code === STORE_PIN_OUT_OF_MARKET) {
    return body.message ?? 'That pin is outside the area Swift serves. Move it to your store.';
  }
  return 'Couldn’t create your store. Try again.';
}
