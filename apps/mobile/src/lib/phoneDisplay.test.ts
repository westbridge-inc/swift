import { describe, expect, it } from 'vitest';
import { formatPhoneForDisplay } from './phoneDisplay';

// A number a customer is about to dial is the wrong place to invent spacing:
// a wrong grouping reads as a wrong number. So anything unrecognised is
// returned untouched rather than guessed at.
describe('formatPhoneForDisplay', () => {
  it('groups a Guyanese number the way it is spoken', () => {
    expect(formatPhoneForDisplay('+5922251234')).toBe('+592 225 1234');
    expect(formatPhoneForDisplay('+5926001234')).toBe('+592 600 1234');
  });

  it('returns anything it does not recognise UNCHANGED', () => {
    // Never mangle. A foreign number, a legacy row, a half-number: shown as-is.
    expect(formatPhoneForDisplay('+12465551234')).toBe('+12465551234');
    expect(formatPhoneForDisplay('+592225')).toBe('+592225');
    expect(formatPhoneForDisplay('225-1234')).toBe('225-1234');
  });

  it('is empty for an absent number, so a caller can test it directly', () => {
    expect(formatPhoneForDisplay(null)).toBe('');
    expect(formatPhoneForDisplay(undefined)).toBe('');
    expect(formatPhoneForDisplay('')).toBe('');
  });

  it('never changes the digits, only the spacing', () => {
    // The property that matters: strip the formatting back out and you must
    // have exactly what was stored.
    for (const n of ['+5922251234', '+5926009999', '+5924441111']) {
      expect(formatPhoneForDisplay(n).replace(/\s/g, '')).toBe(n);
    }
  });
});
