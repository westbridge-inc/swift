import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMERGENCY_CONTACT_CTA,
  NAME_HINT,
  OWN_NUMBER_HINT,
  OWN_NUMBER_ROW,
  emergencyContactForm,
  emergencyContactPhoneE164,
  isOwnContact,
  isOwnNumber,
  phoneHintFor,
} from './emergencyContactForm';
import { DEFAULT_COUNTRY } from './markets';

// ---------------------------------------------------------------------------
// [phone feedback P3] The "Add an emergency contact" form, as rules.
//
// On the owner's phone the number field started as a bare "+" and the
// disabled button read "Enter their name and full number" — a validation hint
// wearing the button's clothes. The number is now typed like sign-in's: a
// fixed +592 in front, local digits on the keypad; the value sent is E.164
// (the API's /^\+[1-9]\d{6,14}$/); the button says "Send code"; what is
// missing is said under the field it belongs to, once that field was left.
// ---------------------------------------------------------------------------

const GY = { dialCode: DEFAULT_COUNTRY.dialCode, countryCode: DEFAULT_COUNTRY.code };
const untouched = { nameTouched: false, phoneTouched: false };
const touched = { nameTouched: true, phoneTouched: true };

/** The API's contact-number rule (apps/api/src/modules/safety/safety.routes.ts). */
const API_CONTACT_E164 = /^\+[1-9]\d{6,14}$/;

describe('the number the API receives', () => {
  it('is the market calling code plus the typed local digits — E.164, as the server demands', () => {
    expect(DEFAULT_COUNTRY.dialCode).toBe('+592');
    expect(emergencyContactPhoneE164('+592', '6123456')).toBe('+5926123456');
    expect(API_CONTACT_E164.test(emergencyContactPhoneE164('+592', '6123456'))).toBe(true);
  });

  it('keeps only digits and clamps to the country’s length, exactly as the sign-in field does', () => {
    expect(emergencyContactPhoneE164('+592', '612-3456')).toBe('+5926123456');
    expect(emergencyContactPhoneE164('+592', '612 3456')).toBe('+5926123456');
    expect(emergencyContactPhoneE164('+592', '61234567')).toBe('+5926123456');
  });

  it('a pasted full number keeps its own digits: the +592 is the prefix, never the start of the local number', () => {
    // DS170 F1: clamping alone turned "+592 600 1234" into +5925926001 — a different person.
    expect(emergencyContactPhoneE164('+592', '+592 600 1234')).toBe('+5926001234');
    expect(emergencyContactPhoneE164('+592', '592 600 1234')).toBe('+5926001234');
    expect(emergencyContactPhoneE164('+592', '00592 600 1234')).toBe('+5926001234');
  });
});

describe('the form state', () => {
  it('starts empty: nothing can be sent, nothing is nagged, the number is just the prefix', () => {
    const form = emergencyContactForm({ name: '', digits: '', ...GY, ...untouched });
    expect(form.canSubmit).toBe(false);
    expect(form.phoneE164).toBe('+592');
    expect(form.nameHint).toBeUndefined();
    expect(form.phoneHint).toBeUndefined();
  });

  it('a name and a full local number can be sent, and the sent number is E.164', () => {
    const form = emergencyContactForm({ name: 'Anita', digits: '6123456', ...GY, ...touched });
    expect(form.canSubmit).toBe(true);
    expect(form.phoneE164).toBe('+5926123456');
    expect(form.nameHint).toBeUndefined();
    expect(form.phoneHint).toBeUndefined();
  });

  it('a missing name is said under the name field — once the field was left, never as the button label', () => {
    expect(emergencyContactForm({ name: 'A', digits: '6123456', ...GY, ...untouched }).nameHint).toBeUndefined();
    const left = emergencyContactForm({ name: 'A', digits: '6123456', ...GY, nameTouched: true, phoneTouched: false });
    expect(left.canSubmit).toBe(false);
    expect(left.nameHint).toBe(NAME_HINT);
    expect(left.phoneHint).toBeUndefined();
  });

  it('a short number is said under the phone field with the market’s example', () => {
    expect(emergencyContactForm({ name: 'Anita', digits: '612', ...GY, ...untouched }).phoneHint).toBeUndefined();
    const left = emergencyContactForm({ name: 'Anita', digits: '612', ...GY, nameTouched: false, phoneTouched: true });
    expect(left.canSubmit).toBe(false);
    expect(left.phoneHint).toBe(phoneHintFor('GY'));
    expect(left.phoneHint).toBe('Enter their full number, e.g. 612 3456.');
    expect(left.nameHint).toBeUndefined();
  });

  it('whitespace is not a name', () => {
    expect(emergencyContactForm({ name: '   ', digits: '6123456', ...GY, ...touched }).canSubmit).toBe(false);
  });

  it('the button says what it does', () => {
    expect(EMERGENCY_CONTACT_CTA).toBe('Send code');
  });
});

// ---------------------------------------------------------------------------
// [Q9] The owner, on his phone: the form took his own number as his emergency
// contact. The API now refuses it (EMERGENCY_CONTACT_IS_YOU) and never alerts
// a row that holds it; the form says so before the tap, in the same words,
// and a row saved before that rule is marked in the list.
// ---------------------------------------------------------------------------

/** The signed-in account's phone, as the auth store holds it. */
const MINE = '+5926123456';

describe('[Q9] your own number is not an emergency contact', () => {
  it('the same number matches however it is written; another number, or no signed-in phone, never does', () => {
    expect(isOwnNumber('+5926123456', MINE)).toBe(true);
    expect(isOwnNumber('+5926123456', '5926123456')).toBe(true);
    expect(isOwnNumber('+5926123456', '+592 612-3456')).toBe(true);
    expect(isOwnNumber('+5926001234', MINE)).toBe(false);
    expect(isOwnNumber('+5926123456', null)).toBe(false);
    expect(isOwnNumber('+5926123456', undefined)).toBe(false);
    expect(isOwnNumber('', '')).toBe(false);
  });

  it('typing your own number disables the button and says why at once, before the field is left; someone else’s is sent as before', () => {
    const own = emergencyContactForm({ name: 'Anita', digits: '6123456', ...GY, ...untouched, ownPhone: MINE });
    expect(own.phoneE164).toBe(MINE);
    expect(own.canSubmit).toBe(false);
    expect(own.phoneHint).toBe(OWN_NUMBER_HINT);
    expect(own.nameHint).toBeUndefined();

    const other = emergencyContactForm({ name: 'Anita', digits: '6001234', ...GY, ...touched, ownPhone: MINE });
    expect(other.canSubmit).toBe(true);
    expect(other.phoneE164).toBe('+5926001234');
    expect(other.phoneHint).toBeUndefined();
  });

  it('a listed row is yours when the server flags it (the phone it holds now) or when it matches this signed-in phone', () => {
    // flagged by the server even though this device's copy of the phone differs — e.g. changed elsewhere
    expect(isOwnContact({ phoneE164: '+5926001234', isOwnNumber: true }, MINE)).toBe(true);
    // a server that does not send the flag yet: this phone's own comparison
    expect(isOwnContact({ phoneE164: MINE }, MINE)).toBe(true);
    expect(isOwnContact({ phoneE164: '+5926001234', isOwnNumber: false }, MINE)).toBe(false);
    expect(isOwnContact({ phoneE164: '+5926001234' }, null)).toBe(false);
  });

  it('the words: the form’s hint IS the API’s refusal, and the row says it will not be alerted', () => {
    expect(OWN_NUMBER_HINT).toBe('An emergency contact must be someone else. Enter their number, not yours.');
    const api = readFileSync(new URL('../../../api/src/modules/safety/emergency-contact.service.ts', import.meta.url), 'utf8');
    expect(api).toContain(`export const EMERGENCY_CONTACT_IS_YOU_MESSAGE = '${OWN_NUMBER_HINT}';`);
    expect(OWN_NUMBER_ROW).toBe('This is your own number — it won’t be alerted. Add someone else.');
  });
});
