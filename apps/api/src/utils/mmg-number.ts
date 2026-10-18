import { AppError } from './errors';
import { validatePublicPhone } from './vendor-public-phone';

/**
 * [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The store's MMG NUMBER: where a
 * customer who chose MMG sends the order money, directly, in MMG's own app.
 * Swift never holds, moves or confirms that money: it shows the number and the
 * exact amount on the customer's accepted order, and the store taps
 * "Paid by MMG" when it sees the money land in its own MMG account.
 *
 * Like the public call-me number, this is never `Vendor.phone` (the account
 * contact). The store chooses to give it, for exactly this purpose.
 *
 * Pure and side-effect free, so the write boundary, the checkout and the
 * customer's order screen reach the same verdict about the same stored string.
 */

export type MmgNumberRejection =
  | 'MISSING'
  | 'TOO_LONG'
  | 'MALFORMED'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'WRONG_LENGTH'
  | 'NOT_A_MOBILE';

export type MmgNumberValidation =
  | { valid: true; number: string }
  | { valid: false; reason: MmgNumberRejection };

const GY_PREFIX = '+592';
/** MMG wallets live on Guyanese MOBILE lines: subscriber numbers that start 6 or 7. */
const GY_MOBILE_LEADING = /^[67]/;

export function validateMmgNumber(raw: string | null | undefined): MmgNumberValidation {
  // A shopkeeper types their number the way they say it: "600 1234" or
  // "592 600 1234". Both mean +592 600 1234; anything else goes through as typed.
  const trimmed = raw?.trim() ?? '';
  const bare = /^[0-9 ()-]+$/.test(trimmed) ? trimmed.replace(/[^0-9]/g, '') : null;
  const spelled = bare?.length === 7 ? `${GY_PREFIX}${bare}` : bare?.length === 10 && bare.startsWith('592') ? `+${bare}` : trimmed;
  // One canonical form, from the same normalizer and Guyana rules the call-me
  // number uses; only the mobile requirement is added here.
  const base = validatePublicPhone(spelled);
  if (!base.valid) {
    return { valid: false, reason: base.reason === 'NOT_A_SUBSCRIBER_LINE' ? 'NOT_A_MOBILE' : base.reason };
  }
  const national = base.phone.slice(GY_PREFIX.length);
  if (!base.phone.startsWith(GY_PREFIX) || !GY_MOBILE_LEADING.test(national)) {
    return { valid: false, reason: 'NOT_A_MOBILE' };
  }
  return { valid: true, number: base.phone };
}

/** A stored value is untrusted until this read boundary: a bad row shows no number, never a wrong one. */
export function safeMmgNumber(raw: string | null | undefined): string | null {
  const result = validateMmgNumber(raw);
  return result.valid ? result.number : null;
}

/** Write boundary. Empty is an explicit opt-out (the store stops taking MMG) and never throws. */
export function mmgNumberForWrite(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const result = validateMmgNumber(raw);
  if (result.valid) return result.number;
  throw new AppError(400, 'INVALID_MMG_NUMBER', mmgNumberErrorMessage(result.reason));
}

/** Written for the shopkeeper typing it: says what to type instead. */
export function mmgNumberErrorMessage(reason: MmgNumberRejection): string {
  switch (reason) {
    case 'COUNTRY_NOT_SUPPORTED':
      return 'Enter a Guyana mobile number starting with +592.';
    case 'WRONG_LENGTH':
      return 'A Guyana mobile number has 7 digits after +592, like +592 600 1234.';
    case 'NOT_A_MOBILE':
      return 'MMG works on a mobile number. Enter the mobile number your MMG account uses, like +592 600 1234.';
    default:
      return 'Enter the mobile number your MMG account uses, including +592.';
  }
}

/** "+5926001234" → "+592 600 1234", how a customer reads it off the screen. */
export function displayMmgNumber(number: string): string {
  const national = number.startsWith(GY_PREFIX) ? number.slice(GY_PREFIX.length) : number;
  return national.length === 7 ? `${GY_PREFIX} ${national.slice(0, 3)} ${national.slice(3)}` : number;
}
