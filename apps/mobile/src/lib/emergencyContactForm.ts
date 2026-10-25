import { clampPhone, phoneExample, phoneLenState } from './phone';

// The "Add an emergency contact" form, as pure rules — the screen renders
// what this decides and sends exactly the number this composes.
//
// The phone is typed the way sign-in takes it: the market's calling code is
// fixed in front (Guyana, +592) and the person types the local digits on the
// numeric keypad. The value SENT is E.164, which is what the API's contact
// schema demands (apps/api safety.routes: /^\+[1-9]\d{6,14}$/) and what the
// SOS fan-out texts. The button says what it does — "Send code" — and is
// enabled only when the form is valid; what is missing is said under the
// field it belongs to, never as the button's label.

/** The API's own contact-number rule, mirrored so the button cannot enable a
 *  number the server would refuse. */
const CONTACT_E164 = /^\+[1-9]\d{6,14}$/;

export const EMERGENCY_CONTACT_CTA = 'Send code';
export const NAME_HINT = 'Enter their name.';
export const NAME_MIN_LENGTH = 2;

// [Q9] An emergency contact is someone else. The API refuses the account's
// own number (EMERGENCY_CONTACT_IS_YOU) and never alerts a row that holds it;
// the form says so before the tap, in the server's own words, and the list
// marks a row saved before that rule.
export const OWN_NUMBER_HINT = 'An emergency contact must be someone else. Enter their number, not yours.';
export const OWN_NUMBER_ROW = 'This is your own number — it won’t be alerted. Add someone else.';

/** The same number, however it is written: digits only on both sides. */
export function isOwnNumber(contactPhone: string, ownPhone: string | null | undefined): boolean {
  const own = (ownPhone ?? '').replace(/\D/g, '');
  return own.length > 0 && own === contactPhone.replace(/\D/g, '');
}

/** A listed contact holding the account's own number: flagged by the server
 *  (compared with the phone the account holds now), or matched here against
 *  the signed-in phone for a server that does not send the flag yet. */
export function isOwnContact(
  contact: { phoneE164: string; isOwnNumber?: boolean },
  ownPhone: string | null | undefined,
): boolean {
  return contact.isOwnNumber === true || isOwnNumber(contact.phoneE164, ownPhone);
}

export interface EmergencyContactFormInput {
  name: string;
  /** Local digits as typed, without the calling code. */
  digits: string;
  dialCode: string;
  countryCode: string;
  /** Hints appear once a field has been left, never while it is first typed. */
  nameTouched: boolean;
  phoneTouched: boolean;
  /** The signed-in account's phone; its own number is never a contact. */
  ownPhone?: string | null;
}

export interface EmergencyContactFormState {
  canSubmit: boolean;
  /** The number the API receives — calling code plus clamped local digits. */
  phoneE164: string;
  nameHint?: string;
  phoneHint?: string;
}

/** Calling code + the local digits, clamped to the country's length. */
export function emergencyContactPhoneE164(dialCode: string, digits: string): string {
  return `${dialCode}${clampPhone(dialCode, digits)}`;
}

export function phoneHintFor(countryCode: string): string {
  return `Enter their full number, e.g. ${phoneExample(countryCode)}.`;
}

export function emergencyContactForm(input: EmergencyContactFormInput): EmergencyContactFormState {
  const nameOk = input.name.trim().length >= NAME_MIN_LENGTH;
  const phoneE164 = emergencyContactPhoneE164(input.dialCode, input.digits);
  const phoneOk = phoneLenState(input.dialCode, input.digits) === 'ok' && CONTACT_E164.test(phoneE164);
  // The account's own number is said at once, not on blur: matching it means
  // the number is complete, not half-typed, and the button it disables must
  // never sit greyed out with no reason under it.
  const ownNumber = isOwnNumber(phoneE164, input.ownPhone);
  return {
    canSubmit: nameOk && phoneOk && !ownNumber,
    phoneE164,
    ...(input.nameTouched && !nameOk ? { nameHint: NAME_HINT } : {}),
    ...(ownNumber
      ? { phoneHint: OWN_NUMBER_HINT }
      : input.phoneTouched && !phoneOk ? { phoneHint: phoneHintFor(input.countryCode) } : {}),
  };
}
