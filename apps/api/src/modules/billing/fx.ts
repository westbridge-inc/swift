import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

// USD Platform Pricing — the FX core (batching/USD spec System 2). Three laws:
// USD is the truth (the price book), the charge pins the rate (immutable trio),
// local is what moves (settlement). THIS FILE is the only place conversion
// happens — one pure function, grep-able, table-tested. No FX feeds in v1:
// the founder sets rates by hand; append-only history is the audit.

export interface CurrencyFormat {
  symbol: string;
  decimals: number;
}

/** Part 20 formatter law — symbols + decimals in ONE table, snapshot-tested.
 *  Hand-built money strings elsewhere are the bug. */
export const CURRENCY_FORMATS: Record<string, CurrencyFormat> = {
  USD: { symbol: 'US$', decimals: 2 },
  GYD: { symbol: 'GY$', decimals: 0 },
  TTD: { symbol: 'TT$', decimals: 2 },
  JMD: { symbol: 'J$', decimals: 0 },
  BBD: { symbol: 'Bds$', decimals: 2 },
};

export function formatMoney(amount: number | Prisma.Decimal, currency: string): string {
  const fmt = CURRENCY_FORMATS[currency] ?? { symbol: `${currency} `, decimals: 2 };
  const n = Number(amount);
  return `${fmt.symbol}${n.toLocaleString('en-US', { minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals })}`;
}

/** HALF_UP rounding to a settlement increment (GYD:100, TTD:1, JMD:50, BBD:1). */
export function roundToIncrement(amount: number, increment: number): number {
  if (increment <= 0) return amount;
  return Math.round(amount / increment) * increment;
}

export interface ConversionResult {
  amountLocal: number;
  minClamped: boolean;
}

/** THE conversion function (Part 11) — the single source:
 *  amountLocal = roundToIncrement(amountUsd × rate, increment, HALF_UP),
 *  clamped to one increment so a zero-amount charge is impossible by
 *  construction (Part 20 minimum clamp → MIN_CLAMPED audit flag). */
export function convertUsdToLocal(amountUsd: number, rate: number, increment: number): ConversionResult {
  const raw = amountUsd * rate;
  let amountLocal = Math.round(raw / increment) * increment; // HALF_UP for positive values
  let minClamped = false;
  if (amountLocal < increment && amountUsd > 0) {
    amountLocal = increment;
    minClamped = true;
  }
  return { amountLocal, minClamped };
}

/** Part 20 — ONE rate per billing run: resolved once at job start, stamped on
 *  every charge that run creates. Latest effective rate for the quote. */
export async function resolveRateForRun(prisma: PrismaClient, quote: string) {
  return prisma.fxRate.findFirst({
    where: { quote, effectiveFrom: { lte: new Date() } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

export type RateStaleness = 'FRESH' | 'STALE_30D' | 'STALE_90D';

/** Part 12 staleness guard — the system nags, it never blocks billing. */
export function rateStaleness(effectiveFrom: Date, now = new Date()): RateStaleness {
  const ageDays = (now.getTime() - effectiveFrom.getTime()) / 86_400_000;
  if (ageDays > 90) return 'STALE_90D';
  if (ageDays > 30) return 'STALE_30D';
  return 'FRESH';
}

export interface RateValidation {
  ok: boolean;
  error?: string;
  /** >20% move from the previous same-quote rate — the fat-finger guard:
   *  the admin must type the quote code to confirm (Part 20). */
  requiresTypedConfirmation: boolean;
  deltaPct: number | null;
}

export function validateNewRate(rate: number, previousRate: number | null): RateValidation {
  if (!(rate > 0)) return { ok: false, error: 'Rate must be greater than zero.', requiresTypedConfirmation: false, deltaPct: null };
  const decimals = (String(rate).split('.')[1] ?? '').length;
  if (decimals > 6) return { ok: false, error: 'Rate supports at most 6 decimal places.', requiresTypedConfirmation: false, deltaPct: null };
  if (previousRate === null || previousRate === 0) return { ok: true, requiresTypedConfirmation: false, deltaPct: null };
  const deltaPct = Math.abs(rate - previousRate) / previousRate;
  return { ok: true, requiresTypedConfirmation: deltaPct > 0.2, deltaPct: Math.round(deltaPct * 10000) / 10000 };
}

/** Part 12's >2% notice rule — pure trigger math, timing owned by the caller. */
export function noticeRequired(previousLocal: number, nextLocal: number): boolean {
  if (previousLocal <= 0) return false;
  return Math.abs(nextLocal - previousLocal) / previousLocal > 0.02;
}

/** The fee-payer facing dual string (Part 13): "US$25.00 / week · GY$5,200 this week". */
export function dualDisplay(amountUsd: number, amountLocal: number, currency: string): string {
  return `${formatMoney(amountUsd, 'USD')} / week · ${formatMoney(amountLocal, currency)} this week`;
}
