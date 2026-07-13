import { validatePhoneNumberLength } from 'libphonenumber-js';

// Phone handling for Swift's markets — and any country we expand to.
//
// LENGTH is delegated to libphonenumber-js (pure JS, no native module) so it's
// correct for every country, including LONG and VARIABLE-length numbers — not
// hardcoded to Guyana's 7 digits. We judge the full E.164 (dial code + the
// digits the user types), because for NANP islands the area code lives in the
// dial code (+1784) while libphonenumber counts it as part of the national
// number. That single rule covers Caribbean 7-digit, UK/Nigeria 10-digit, etc.
//
// EXAMPLE (placeholder) stays a small curated table so each market shows a
// realistic local number; unknown countries fall back to a generic hint.

const EXAMPLES: Record<string, string> = {
  AG: '464 1234', // Antigua & Barbuda
  BS: '359 1234', // Bahamas
  BB: '250 1234', // Barbados
  BZ: '610 1234', // Belize
  DM: '225 1234', // Dominica
  GD: '403 1234', // Grenada
  GY: '612 3456', // Guyana
  JM: '210 1234', // Jamaica
  KN: '765 1234', // Saint Kitts & Nevis
  LC: '284 1234', // Saint Lucia
  VC: '430 1234', // Saint Vincent & the Grenadines
  SR: '741 1234', // Suriname
  TT: '291 1234', // Trinidad & Tobago
};
const FALLBACK_EXAMPLE = '612 3456';

/** Realistic local-number example for the placeholder. */
export function phoneExample(countryCode?: string | null): string {
  return (countryCode ? EXAMPLES[countryCode] : undefined) ?? FALLBACK_EXAMPLE;
}

export type PhoneLenState = 'short' | 'ok' | 'long';

/**
 * Length state of the local number the user has typed, for the given dial code.
 * 'ok' means it's a valid length for that country (fixed OR variable OR long);
 * 'long' means one digit too many. Falls back to a lenient 6–15 digit range if
 * libphonenumber doesn't recognise the dial code, so an unknown market still
 * works instead of being un-submittable.
 */
export function phoneLenState(dialCode: string | null | undefined, digits: string): PhoneLenState {
  const local = digits.replace(/\D/g, '');
  const res = dialCode ? validatePhoneNumberLength(`${dialCode}${local}`) : 'INVALID_COUNTRY';
  if (res === undefined) return 'ok';
  if (res === 'TOO_LONG') return 'long';
  if (res === 'TOO_SHORT') return 'short';
  // INVALID_COUNTRY / NOT_A_NUMBER / no dial code → lenient fallback.
  if (local.length > 15) return 'long';
  return local.length >= 6 ? 'ok' : 'short';
}

/** Clamp typed digits to the longest prefix that isn't too long for the country. */
export function clampPhone(dialCode: string | null | undefined, digits: string): string {
  let local = digits.replace(/\D/g, '').slice(0, 15); // hard E.164 ceiling
  while (local.length > 6 && phoneLenState(dialCode, local) === 'long') {
    local = local.slice(0, -1);
  }
  return local;
}
