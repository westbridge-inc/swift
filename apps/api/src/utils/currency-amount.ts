import { moneyBoundaryCounter } from '../plugins/observability';

/**
 * [M-36] Every amount carries its currency and ISO exponent; no naked number
 * changes unit across a boundary.
 *
 * Stop-ship register M-36: the client-money schema was named "minor" while
 * accepting whole GYD; receipts and statements hard-coded "GYD" / "GY$";
 * the card and MMG adapters multiplied by 100 on the assumption that every
 * currency has two decimals; ads kept its own scale table. A fractional or
 * non-GYD market could be 100× wrong, rounded inconsistently, or mislabeled.
 *
 * Now there is ONE exponent registry, a CurrencyAmount (bigint minor units +
 * currency + exponent), and boundary adapters that are the only place a unit
 * changes: to a provider's minor units and back, and to a human string. The
 * platform's storage unit is MAJOR units (whole GYD today) in Decimal(12,2)
 * columns — declared, per column, in utils/money-units.ts.
 */
export interface CurrencyInfo {
  code: string;
  /** ISO 4217 exponent: minor units per major unit = 10^exponent. */
  exponent: number;
  symbol: string;
  name: string;
}

const REGISTRY = new Map<string, CurrencyInfo>([
  ['GYD', { code: 'GYD', exponent: 2, symbol: 'GY$', name: 'Guyanese dollar' }],
  ['USD', { code: 'USD', exponent: 2, symbol: 'US$', name: 'US dollar' }],
  ['TTD', { code: 'TTD', exponent: 2, symbol: 'TT$', name: 'Trinidad and Tobago dollar' }],
  ['JMD', { code: 'JMD', exponent: 2, symbol: 'J$', name: 'Jamaican dollar' }],
  ['BBD', { code: 'BBD', exponent: 2, symbol: 'Bds$', name: 'Barbadian dollar' }],
  ['XCD', { code: 'XCD', exponent: 2, symbol: 'EC$', name: 'East Caribbean dollar' }],
  ['SRD', { code: 'SRD', exponent: 2, symbol: 'Sr$', name: 'Surinamese dollar' }],
  ['BZD', { code: 'BZD', exponent: 2, symbol: 'BZ$', name: 'Belize dollar' }],
  ['BSD', { code: 'BSD', exponent: 2, symbol: 'B$', name: 'Bahamian dollar' }],
  ['HTG', { code: 'HTG', exponent: 2, symbol: 'G', name: 'Haitian gourde' }],
  ['DOP', { code: 'DOP', exponent: 2, symbol: 'RD$', name: 'Dominican peso' }],
  ['KYD', { code: 'KYD', exponent: 2, symbol: 'CI$', name: 'Cayman Islands dollar' }],
  ['AWG', { code: 'AWG', exponent: 2, symbol: 'Afl.', name: 'Aruban florin' }],
  ['ANG', { code: 'ANG', exponent: 2, symbol: 'NAf.', name: 'Netherlands Antillean guilder' }],
]);

/** Tests and a future market register here; production markets are seeded above. */
export function registerCurrency(info: CurrencyInfo): void {
  REGISTRY.set(info.code, { ...info });
}

export function isKnownCurrency(code: string): boolean {
  return REGISTRY.has(code);
}

/** The registry entry, or — for a code nobody registered — a counted
 *  2-decimal fallback that names the code as its symbol, never silently GYD. */
export function currencyInfo(code: string): CurrencyInfo {
  const known = REGISTRY.get(code);
  if (known) return known;
  moneyBoundaryCounter.labels('unknown_currency', code).inc();
  return { code, exponent: 2, symbol: `${code} `, name: code };
}

export interface CurrencyAmount {
  readonly currency: string;
  readonly exponent: number;
  readonly minor: bigint;
}

function decimalText(value: number | string | { toString(): string }): string {
  const text = typeof value === 'number' ? value.toString() : typeof value === 'string' ? value.trim() : value.toString();
  return text;
}

/** From MAJOR units (a whole number, a decimal string, a Prisma Decimal).
 *  Refuses more fractional digits than the currency's exponent, and anything
 *  that is not a finite decimal. */
export function fromMajor(value: number | string | { toString(): string }, currency: string): CurrencyAmount {
  const info = currencyInfo(currency);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`${currency} amount must be finite`);
  const text = decimalText(value);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`Invalid decimal money value: ${text}`);
  const negative = match[1] === '-';
  const whole = match[2]!;
  const fraction = match[3] ?? '';
  if (fraction.replace(/0+$/, '').length > info.exponent) {
    throw new RangeError(`${currency} supports at most ${info.exponent} fractional digit(s): ${text}`);
  }
  const factor = 10n ** BigInt(info.exponent);
  const minor = BigInt(whole) * factor + BigInt((fraction.slice(0, info.exponent) || '').padEnd(info.exponent, '0') || '0');
  return { currency: info.code, exponent: info.exponent, minor: negative ? -minor : minor };
}

/** From MINOR units (a provider's integer). */
export function fromMinor(minor: bigint | number | string, currency: string): CurrencyAmount {
  const info = currencyInfo(currency);
  let m: bigint;
  if (typeof minor === 'bigint') m = minor;
  else if (typeof minor === 'number') {
    if (!Number.isSafeInteger(minor)) throw new RangeError(`${currency} minor units must be a safe integer: ${minor}`);
    m = BigInt(minor);
  } else {
    if (!/^-?\d+$/.test(minor.trim())) throw new TypeError(`Invalid minor-unit string: ${minor}`);
    m = BigInt(minor.trim());
  }
  return { currency: info.code, exponent: info.exponent, minor: m };
}

export function toMajorString(amount: CurrencyAmount): string {
  const factor = 10n ** BigInt(amount.exponent);
  const abs = amount.minor < 0n ? -amount.minor : amount.minor;
  const whole = abs / factor;
  const sign = amount.minor < 0n ? '-' : '';
  if (amount.exponent === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${(abs % factor).toString().padStart(amount.exponent, '0')}`;
}

export function toMajorNumber(amount: CurrencyAmount): number {
  return Number(toMajorString(amount));
}

export function sameCurrency(a: CurrencyAmount, b: CurrencyAmount): void {
  if (a.currency !== b.currency) throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function addAmounts(a: CurrencyAmount, b: CurrencyAmount): CurrencyAmount {
  sameCurrency(a, b);
  return { currency: a.currency, exponent: a.exponent, minor: a.minor + b.minor };
}

/** The human string: the registry symbol, grouped digits, fractional digits
 *  only when the amount has them, and the ISO code when asked for. */
export function formatAmount(amount: CurrencyAmount, opts: { code?: boolean } = {}): string {
  const info = currencyInfo(amount.currency);
  const factor = 10n ** BigInt(amount.exponent);
  const abs = amount.minor < 0n ? -amount.minor : amount.minor;
  const whole = abs / factor;
  const frac = abs % factor;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = amount.exponent > 0 && frac !== 0n ? `.${frac.toString().padStart(amount.exponent, '0')}` : '';
  const sign = amount.minor < 0n ? '−' : '';
  return `${sign}${info.symbol}${grouped}${fraction}${opts.code ? ` ${info.code}` : ''}`;
}

/** The one-liner every renderer uses: a stored MAJOR number in a named
 *  currency. `whole` renders at the column's declared unit (MAJOR_WHOLE in
 *  utils/money-units.ts — whole GYD), rounding once, here, and nowhere else;
 *  otherwise the currency's own exponent. */
export function formatMoney(major: unknown, currency: string, opts: { code?: boolean; whole?: boolean } = {}): string {
  const n = Number(major ?? 0);
  const info = currencyInfo(currency);
  const digits = opts.whole ? 0 : info.exponent;
  const rounded = Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
  return formatAmount(fromMajor(rounded.toFixed(digits), currency), { code: opts.code });
}

/** The platform's ceiling for a MAJOR-unit amount — one unit below the
 *  smallest money sink (Decimal(10,2)). Anything at or above it arriving where
 *  a major amount is expected looks minor-scaled: a scale anomaly. */
export const MAJOR_AMOUNT_CEILING = 99_999_999;

/** Boundary adapter → a provider's integer minor units (Stripe, MMG). The
 *  ONLY place a major amount becomes minor. A major amount that already looks
 *  minor-scaled is refused and counted, never sent 100× too large. */
export function toProviderMinor(major: number, currency: string, boundary: string): number {
  if (!Number.isFinite(major) || major < 0) throw new RangeError(`${boundary}: a provider amount must be a finite non-negative ${currency} major amount, got ${major}`);
  if (major >= MAJOR_AMOUNT_CEILING) {
    moneyBoundaryCounter.labels('scale_anomaly', boundary).inc();
    throw new RangeError(`${boundary}: ${major} ${currency} looks minor-scaled (at or above the major ceiling) — refusing to scale it again`);
  }
  const info = currencyInfo(currency);
  const minor = Math.round(major * 10 ** info.exponent);
  if (!Number.isSafeInteger(minor)) throw new RangeError(`${boundary}: ${major} ${currency} does not fit a safe integer of minor units`);
  return minor;
}

/** Boundary adapter ← a provider's minor units, to the platform's major number. */
export function fromProviderMinor(minor: number | string, currency: string, boundary: string): number {
  const amount = fromMinor(typeof minor === 'string' ? minor : Math.round(minor), currency);
  const major = toMajorNumber(amount);
  if (major >= MAJOR_AMOUNT_CEILING) moneyBoundaryCounter.labels('scale_anomaly', boundary).inc();
  return major;
}
