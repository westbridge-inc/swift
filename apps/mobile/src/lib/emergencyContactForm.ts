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

export interface EmergencyContactFormInput {
  name: string;
  /** Local digits as typed, without the calling code. */
  digits: string;
  dialCode: string;
  countryCode: string;
  /** Hints appear once a field has been left, never while it is first typed. */
  nameTouched: boolean;
  phoneTouched: boolean;
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
  return {
    canSubmit: nameOk && phoneOk,
    phoneE164,
    ...(input.nameTouched && !nameOk ? { nameHint: NAME_HINT } : {}),
    ...(input.phoneTouched && !phoneOk ? { phoneHint: phoneHintFor(input.countryCode) } : {}),
  };
}
