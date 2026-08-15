/**
 * Exact money primitives for the ads domain.
 *
 * Authoritative amounts are always integer minor units. Decimal/string parsing is
 * deliberately strict: callers must supply a plain, non-negative decimal whose
 * precision exactly fits the currency. We never round at this boundary.
 */

export const ADS_CURRENCY_MINOR_SCALE = {
  GYD: 2,
  USD: 2,
  TTD: 2,
  JMD: 2,
  BBD: 2,
  XCD: 2,
} as const;

export type AdsCurrency = keyof typeof ADS_CURRENCY_MINOR_SCALE;

export interface DecimalStringLike {
  toString(): string;
}

function currencyScale(currency: string): number {
  if (!Object.prototype.hasOwnProperty.call(ADS_CURRENCY_MINOR_SCALE, currency)) {
    throw new RangeError(`Unsupported ads currency: ${currency}`);
  }

  return ADS_CURRENCY_MINOR_SCALE[currency as AdsCurrency];
}

function decimalText(value: string | DecimalStringLike): string {
  const text = typeof value === 'string' ? value : value.toString();
  if (typeof text !== 'string') {
    throw new TypeError('Money value must stringify to a decimal string');
  }
  return text;
}

/** Parse a major-unit decimal into exact integer minor units without rounding. */
export function majorDecimalToMinor(value: string | DecimalStringLike, currency: string): bigint {
  const scale = currencyScale(currency);
  const text = decimalText(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);

  if (!match) {
    throw new TypeError(`Invalid non-negative decimal money value: ${text}`);
  }

  const whole = match[1]!;
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    throw new RangeError(`${currency} supports at most ${scale} fractional digits`);
  }

  const factor = 10n ** BigInt(scale);
  const paddedFraction = fraction.padEnd(scale, '0');
  return BigInt(whole) * factor + BigInt(paddedFraction || '0');
}

/** Format exact integer minor units as a canonical fixed-scale major-unit string. */
export function minorToMajorString(minor: bigint, currency: string): string {
  if (minor < 0n) {
    throw new RangeError('Money amount cannot be negative');
  }

  const scale = currencyScale(currency);
  const factor = 10n ** BigInt(scale);
  const whole = minor / factor;
  if (scale === 0) return whole.toString();

  const fraction = (minor % factor).toString().padStart(scale, '0');
  return `${whole}.${fraction}`;
}

/** Divide non-negative integer minor units using deterministic half-up rounding. */
export function divideMinorHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) {
    throw new RangeError('Money numerator cannot be negative');
  }
  if (denominator <= 0n) {
    throw new RangeError('Money denominator must be positive');
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}
