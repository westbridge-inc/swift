import { AppError } from './errors';
import { normalizePhone } from './phone';

/**
 * The number a store CHOOSES to publish so a customer can call before ordering
 * — "do you have this in stock", "can you do this today".
 *
 * This is deliberately NOT `Vendor.phone`. That field is the operational and
 * account contact: it is collected at onboarding as free text, it is frequently
 * the owner's own line (which for a small Guyanese shop is also the number that
 * receives their login OTP), and no vendor ever agreed to have it published.
 * Publishing it would be a disclosure they never made. So publication is a
 * separate, opt-in field and null means "no call button" — exactly the shape
 * `mmgPayUrl` uses for the same reason, and this module mirrors that one on
 * purpose: validate on write, re-validate on read, gate the exposure.
 *
 * There is no OTP step, matching the MMG link the vendor pastes on the same
 * dashboard. That is a deliberate founder decision and it is why the shape
 * checks below carry real weight: a mistyped MMG link misdirects money the
 * customer can see before they pay, but a mistyped phone number rings an
 * uninvolved third party who never opted into anything and cannot make it stop.
 * Requiring a complete national number is what keeps a short code, a service
 * number or a half-typed fragment from ever reaching a customer's dialler.
 *
 * LANDLINES ARE FIRST-CLASS. A fixed GTT line is what many shops actually
 * answer, so nothing here privileges a mobile prefix — the founder's point
 * exactly. The only question asked is whether this is a complete, dialable
 * Guyanese subscriber number.
 */

export type PublicPhoneRejection =
  | 'MISSING'
  | 'TOO_LONG'
  | 'MALFORMED'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'WRONG_LENGTH'
  | 'NOT_A_SUBSCRIBER_LINE';

export type PublicPhoneValidation =
  | { valid: true; phone: string }
  | { valid: false; reason: PublicPhoneRejection };

/** Guyana. Single market by founder decision; a second entry here is the only
 *  change another market needs, so the rule stays in one place rather than
 *  being re-expressed per call site. */
const GY_DIALING_CODE = '592';

/** Guyana subscriber numbers are 7 digits after the country code. */
const GY_NATIONAL_DIGITS = 7;

/**
 * Valid leading digits for a Guyanese SUBSCRIBER line: 2–5 are the regional
 * fixed ranges (Georgetown, Berbice, Essequibo, Linden), 6–7 are mobile.
 *
 * 0 and 1 are trunk/international prefixes and 8–9 are service ranges, so no
 * subscriber can be reached on them. Excluding them is not tidiness: it is what
 * stops a store publishing a number that dials something other than the store.
 * The 7-digit requirement above already makes an emergency short code (911,
 * 912, 913) impossible to store, which is the case that actually matters — a
 * "call us" button must never dial the police.
 */
const GY_SUBSCRIBER_LEADING = /^[2-7]/;

/**
 * Validate one vendor's published call-me number.
 *
 * Pure and side-effect free, like `validateMmgPayUrl`, so the read boundary and
 * the write boundary reach exactly the same verdict about the same string.
 */
export function validatePublicPhone(raw: string | null | undefined): PublicPhoneValidation {
  const candidate = raw?.trim();
  if (!candidate) return { valid: false, reason: 'MISSING' };
  // Guard before normalizing: normalizePhone strips non-digits, so a long
  // paragraph of punctuation would otherwise collapse into something short and
  // plausible instead of being rejected as the junk it is.
  if (candidate.length > 32) return { valid: false, reason: 'TOO_LONG' };

  // ONE canonical form, produced by the ONE normalizer the platform already
  // matches accounts on. Re-implementing "strip spaces and dashes" here is how
  // a vendor ends up stored in a spelling no other surface recognises.
  const normalized = normalizePhone(candidate);
  if (!/^\+[0-9]+$/.test(normalized)) return { valid: false, reason: 'MALFORMED' };

  const digits = normalized.slice(1);
  if (!digits.startsWith(GY_DIALING_CODE)) return { valid: false, reason: 'COUNTRY_NOT_SUPPORTED' };

  const national = digits.slice(GY_DIALING_CODE.length);
  if (national.length !== GY_NATIONAL_DIGITS) return { valid: false, reason: 'WRONG_LENGTH' };
  if (!GY_SUBSCRIBER_LEADING.test(national)) return { valid: false, reason: 'NOT_A_SUBSCRIBER_LINE' };

  return { valid: true, phone: normalized };
}

/**
 * A stored value is untrusted until this read boundary.
 *
 * A row can predate this validator, be written by a migration, or be edited
 * straight in the database — and the consequence of trusting one blindly is a
 * customer dialling it. Every customer-facing read goes through here, so a bad
 * row degrades to "no call button" rather than to a wrong call.
 */
export function safePublicPhone(raw: string | null | undefined): string | null {
  const result = validatePublicPhone(raw);
  return result.valid ? result.phone : null;
}

/**
 * Write-boundary adapter for the vendor dashboard.
 *
 * Empty is an explicit opt-OUT (the store takes its call button down), which is
 * why it returns null instead of throwing: a vendor must always be able to stop
 * publishing a number without having to supply a valid one first.
 */
export function publicPhoneForWrite(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const result = validatePublicPhone(raw);
  if (result.valid) return result.phone;
  throw new AppError(400, 'INVALID_PUBLIC_PHONE', publicPhoneErrorMessage(result.reason));
}

/** Written for the shopkeeper reading it on their own dashboard, not for a
 *  developer reading a log: it has to say what to type instead. */
export function publicPhoneErrorMessage(reason: PublicPhoneRejection): string {
  switch (reason) {
    case 'COUNTRY_NOT_SUPPORTED':
      return 'Enter a Guyana number starting with +592.';
    case 'WRONG_LENGTH':
      return 'A Guyana number has 7 digits after +592, like +592 225 1234.';
    case 'NOT_A_SUBSCRIBER_LINE':
      return 'That is not a number customers can call. Enter your shop landline or mobile.';
    default:
      return 'Enter the phone number customers should call, including +592.';
  }
}
