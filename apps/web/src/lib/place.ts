// ---------------------------------------------------------------------------
// [W-08] A SAVED ADDRESS IS A CLAIM THAT TWO THINGS DESCRIBE THE SAME PLACE.
//
// The address form collected typed text — label, street, city — and, on save,
// asked the browser where the DEVICE was. The two were then stored together as
// one address, with nothing binding them:
//
//     const coords = await currentCoords('place this address on the map');
//     await addAddress({ ...form, latitude: coords.lat, longitude: coords.lng });
//
// Someone adding their home address from the office saved the words "home" and
// the coordinates of the office. The delivery fee, the rider's route and the
// courier's destination all come from the coordinates, so the order goes to the
// office while every screen says home. Nothing in the flow ever asked whether
// the two referred to the same place.
//
// Worse, the text could be edited AFTER the location was taken and the stale
// coordinates would ride along unchanged.
//
// What was already right and is not re-fixed here: `currentCoords` has no
// city-centre fallback — a coordinate is what the device reported or an error
// (F-027-02). This module adds the two things it still lacked: the fix's own
// ACCURACY, and a binding to the exact text it was captured for.
//
// The rule: a place is captured for one exact address string. Change the
// string and the capture is void.
// ---------------------------------------------------------------------------

/** Past this the fix is a neighbourhood, not a doorstep. */
export const MAX_ACCURACY_M = 250;
/** A fix older than this is where you WERE. */
export const MAX_FIX_AGE_MS = 120_000;

export interface SelectedPlace {
  /** The exact address text this fix was captured for. */
  addressKey: string;
  lat: number;
  lng: number;
  /** The device's own stated accuracy, in metres. Never invented. */
  accuracyM: number;
  capturedAt: number;
  source: 'DEVICE';
}

export type PlaceRejection =
  | { ok: false; reason: 'NO_FIX'; message: string }
  | { ok: false; reason: 'INACCURATE'; message: string }
  | { ok: false; reason: 'STALE'; message: string }
  | { ok: false; reason: 'OUT_OF_RANGE'; message: string };

export type PlaceResult = { ok: true; place: SelectedPlace } | PlaceRejection;

/**
 * The canonical form of an address for binding purposes. Case and surrounding
 * whitespace do not change the place; the words do.
 */
export function addressKey(form: { addressLine1: string; city: string }): string {
  return `${form.addressLine1.trim()}|${form.city.trim()}`.toLowerCase().replace(/\s+/g, ' ');
}

/** A real point on Earth, and not the null-island "no fix" pair. */
function isRealPoint(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(lat === 0 && lng === 0);
}

/**
 * Accept a device fix for one exact address, or say precisely why not.
 *
 * `accuracyM` is the browser's own `coords.accuracy`, which the app used to
 * discard entirely — so a ±5 km cell-tower fix became an exact delivery
 * address, indistinguishable from a ±8 m GPS one.
 */
export function acceptFix(input: {
  key: string;
  lat: number;
  lng: number;
  accuracyM: number | null | undefined;
  timestamp: number;
  now: number;
}): PlaceResult {
  const { key, lat, lng, accuracyM, timestamp, now } = input;
  if (!isRealPoint(lat, lng)) {
    return { ok: false, reason: 'OUT_OF_RANGE', message: 'Your device reported a location we can’t use. Try again outdoors.' };
  }
  if (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    // An unknown accuracy is not a good one.
    return { ok: false, reason: 'NO_FIX', message: 'Your device didn’t say how accurate that location is, so we can’t save it as an address.' };
  }
  if (accuracyM > MAX_ACCURACY_M) {
    return {
      ok: false,
      reason: 'INACCURATE',
      message: `That location is only accurate to about ${Math.round(accuracyM)} m — too rough for a delivery address. Move outdoors or turn on precise location and try again.`,
    };
  }
  const age = now - timestamp;
  if (age > MAX_FIX_AGE_MS) {
    return { ok: false, reason: 'STALE', message: 'That location is out of date. Try again.' };
  }
  return { ok: true, place: { addressKey: key, lat, lng, accuracyM, capturedAt: timestamp, source: 'DEVICE' } };
}

/**
 * Is this captured place still the one being saved?
 *
 * This is the whole point of the item. The clause requires that "every address
 * edit invalidates coordinates", and this is where that is enforced: a place
 * captured for one address string does not carry over to a different one.
 */
export function placeMatches(place: SelectedPlace | null, form: { addressLine1: string; city: string }): boolean {
  if (!place) return false;
  return place.addressKey === addressKey(form);
}

/** May this address be saved? Only with a place captured for THIS text. */
export function canSave(place: SelectedPlace | null, form: { addressLine1: string; city: string }): boolean {
  return form.addressLine1.trim().length > 0 && form.city.trim().length > 0 && placeMatches(place, form);
}
