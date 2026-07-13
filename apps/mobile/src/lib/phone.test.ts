import { describe, it, expect } from 'vitest';
import { phoneExample, phoneLenState, clampPhone } from './phone';

describe('phoneLenState', () => {
  it('accepts a valid Caribbean 7-digit local number', () => {
    expect(phoneLenState('+592', '6123456')).toBe('ok'); // Guyana
    expect(phoneLenState('+1784', '4641237')).toBe('ok'); // St Vincent (NANP, area code in dial code)
    expect(phoneLenState('+1246', '2501234')).toBe('ok'); // Barbados
  });

  it('flags too-short and too-long for a fixed-length country', () => {
    expect(phoneLenState('+1784', '46412')).toBe('short');
    expect(phoneLenState('+1784', '46412370')).toBe('long'); // 8 local -> too long
  });

  it('accepts LONG numbers for countries unlike Guyana (variable/10-digit)', () => {
    expect(phoneLenState('+44', '7400123456')).toBe('ok'); // UK 10-digit mobile
    expect(phoneLenState('+234', '8031234567')).toBe('ok'); // Nigeria 10-digit
    expect(phoneLenState('+44', '74001')).toBe('short');
    expect(phoneLenState('+44', '74001234567890')).toBe('long');
  });

  it('falls back to a lenient 6–15 range for an unknown dial code', () => {
    expect(phoneLenState('+9999', '12345')).toBe('short');
    expect(phoneLenState('+9999', '1234567')).toBe('ok');
    expect(phoneLenState(null, '1234567')).toBe('ok');
  });
});

describe('clampPhone', () => {
  it('trims to the longest length valid for the country (typed or pasted)', () => {
    expect(clampPhone('+1784', '46412370')).toBe('4641237'); // 8 -> 7
    expect(clampPhone('+592', '61234569999')).toBe('6123456'); // long paste -> 7
    expect(clampPhone('+44', '7400123456999')).toBe('7400123456'); // -> 10 (UK)
  });
  it('leaves a valid or still-short number untouched', () => {
    expect(clampPhone('+592', '6123456')).toBe('6123456');
    expect(clampPhone('+592', '612')).toBe('612');
  });
  it('strips non-digits', () => {
    expect(clampPhone('+592', '612-3456')).toBe('6123456');
  });
});

describe('phoneExample', () => {
  it('gives a per-country example, with a fallback for unknown', () => {
    expect(phoneExample('AG')).toBe('464 1234');
    expect(phoneExample('GY')).toBe('612 3456');
    expect(phoneExample('ZZ')).toBe('612 3456');
    expect(phoneExample(null)).toBe('612 3456');
  });
});
