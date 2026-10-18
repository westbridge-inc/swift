import { describe, expect, it } from 'vitest';
import { displayMmgNumber, mmgNumberForWrite, safeMmgNumber, validateMmgNumber } from '../utils/mmg-number';

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The store enters its MMG number once;
// it must be a Guyana MOBILE number (+592 then 6 or 7), stored in one canonical form.
describe('validateMmgNumber', () => {
  it.each([
    ['+592 600 1234', '+5926001234'],
    ['592-600-1234', '+5926001234'],
    ['+5927001234', '+5927001234'],
    ['600 1234', '+5926001234'], // said the local way
    ['(592) 600-1234', '+5926001234'],
  ])('accepts the mobile %s as %s', (raw, canonical) => {
    expect(validateMmgNumber(raw)).toEqual({ valid: true, number: canonical });
  });

  it.each([
    ['', 'MISSING'],
    [null, 'MISSING'],
    ['+592 225 1234', 'NOT_A_MOBILE'], // Georgetown landline
    ['+592 333 1234', 'NOT_A_MOBILE'], // Berbice landline
    ['+592 911', 'WRONG_LENGTH'],
    ['911', 'MALFORMED'], // never an emergency short code
    ['225 1234', 'NOT_A_MOBILE'],
    ['+592 600 12345', 'WRONG_LENGTH'],
    ['+1 868 600 1234', 'COUNTRY_NOT_SUPPORTED'],
    ['+592 800 1234', 'NOT_A_MOBILE'],
    ['x'.repeat(40), 'TOO_LONG'],
  ])('refuses %s (%s)', (raw, reason) => {
    expect(validateMmgNumber(raw as string | null)).toEqual({ valid: false, reason });
  });

  it('a stored row is re-checked on read: a landline shows no number', () => {
    expect(safeMmgNumber('+5922251234')).toBeNull();
    expect(safeMmgNumber('+5926001234')).toBe('+5926001234');
  });

  it('empty is an opt-out on write; a bad number says what to type', () => {
    expect(mmgNumberForWrite('')).toBeNull();
    expect(mmgNumberForWrite('   ')).toBeNull();
    expect(() => mmgNumberForWrite('+592 225 1234')).toThrow(/MMG works on a mobile number/);
  });

  it('displays the way a customer reads it', () => {
    expect(displayMmgNumber('+5926001234')).toBe('+592 600 1234');
  });
});
