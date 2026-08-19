import { describe, expect, it } from 'vitest';
import {
  divideMinorHalfUp,
  majorDecimalToMinor,
  minorToMajorString,
} from '../modules/ads/ads-money';

describe('ads exact money primitives', () => {
  it('parses strings and Decimal-like values into exact minor units', () => {
    expect(majorDecimalToMinor('123.45', 'GYD')).toBe(12_345n);
    expect(majorDecimalToMinor('123', 'USD')).toBe(12_300n);
    expect(majorDecimalToMinor({ toString: () => '0.09' }, 'TTD')).toBe(9n);
  });

  it('formats integer minor units as fixed-scale major-unit strings', () => {
    expect(minorToMajorString(12_345n, 'GYD')).toBe('123.45');
    expect(minorToMajorString(9n, 'USD')).toBe('0.09');
    expect(minorToMajorString(0n, 'XCD')).toBe('0.00');
  });

  it('rejects unsupported or non-canonical currencies', () => {
    expect(() => majorDecimalToMinor('1.00', 'EUR')).toThrow(/Unsupported ads currency/);
    expect(() => majorDecimalToMinor('1.00', 'gyd')).toThrow(/Unsupported ads currency/);
    expect(() => minorToMajorString(100n, '')).toThrow(/Unsupported ads currency/);
  });

  it('rejects precision beyond the currency scale instead of rounding it', () => {
    expect(() => majorDecimalToMinor('1.001', 'GYD')).toThrow(/at most 2 fractional digits/);
    expect(() => majorDecimalToMinor('0.009', 'USD')).toThrow(/at most 2 fractional digits/);
  });

  it('rejects malformed, exponent, signed, and negative decimal inputs', () => {
    for (const value of [' 1.00', '1.00 ', '1e2', '+1.00', '-1.00', 'NaN', 'Infinity', '1,000.00']) {
      expect(() => majorDecimalToMinor(value, 'GYD')).toThrow(/Invalid non-negative decimal/);
    }
  });

  it('round-trips large exact amounts and rounds division half-up', () => {
    const text = '9999999999.99';
    const minor = majorDecimalToMinor(text, 'GYD');
    expect(minorToMajorString(minor, 'GYD')).toBe(text);
    expect(divideMinorHalfUp(1n, 2n)).toBe(1n);
    expect(divideMinorHalfUp(4n, 3n)).toBe(1n);
    expect(divideMinorHalfUp(5n, 3n)).toBe(2n);
  });
});
