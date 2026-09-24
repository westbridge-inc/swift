import { describe, expect, it } from 'vitest';
import {
  EMERGENCY_CONTACT_CTA,
  NAME_HINT,
  emergencyContactForm,
  emergencyContactPhoneE164,
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
