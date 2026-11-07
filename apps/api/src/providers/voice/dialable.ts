import { normalizePhone } from '../../utils/phone';

/**
 * [REVIEW-M17 S1-1 · toll fraud] The one rule for every number Swift asks the voice provider to ring, on BOTH
 * legs of a call and in the provider itself. Swift pays for each, and two of them are free text a person typed
 * (a store's account line, a parcel recipient's number), while Twilio's Guyana high-risk ranges are enabled.
 *
 * Only a complete Guyana subscriber number: +592, then 7 digits starting 2-7 (2-5 the regional fixed lines,
 * 6-7 mobile; the same leading digits as a store's published number, utils/vendor-public-phone.ts). Refused:
 * every other country, 0 and 1 (trunk prefixes and the +5920 test range), 8 and 9 (service ranges), short
 * codes such as 911, a number without its country code, and Swift's own caller ID.
 */
export const GY_DIALABLE = /^\+592[2-7]\d{6}$/;

/** The number in its one dialable form, or null when Swift must not ring it. */
export function dialableNumber(raw: string | null | undefined, callerId: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Only spacing is forgiven: anything that is not a digit, a space, a dash, a dot or brackets (or a leading +) is refused.
  if (!/^\+?[\d\s().-]+$/.test(raw.trim())) return null;
  const number = normalizePhone(raw);
  if (!GY_DIALABLE.test(number)) return null;
  if (number === normalizePhone(callerId)) return null;
  return number;
}
