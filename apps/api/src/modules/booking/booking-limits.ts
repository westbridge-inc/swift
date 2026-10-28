import type { PrismaClient } from '@prisma/client';
import { ALGO_DEFAULTS, algoValue } from '../algo/algo-config';

// ---------------------------------------------------------------------------
// [BOOK-S2 · COORD ruling 28 Oct 2026] SLOT SQUATTING. With INSTANT_BOOKING on,
// checkout takes a business's time before anyone pays, so one customer could
// otherwise hold every free hour of a business (or of many). A customer may
// hold at most 2 upcoming appointments with one business and 5 in all
// (RESERVED or CONFIRMED, not yet started). Judged INSIDE the checkout
// transaction, under the customer's booking lock (BookingService
// holdSlotAtCheckout), so two checkouts can never both slip past a cap.
// A cancelled or completed booking frees its place at once.
// ---------------------------------------------------------------------------

export interface BookingLimits {
  perBusiness: number;
  total: number;
}

const MIN = 1;
const MAX = 50;

function clamp(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(n)) return fallback;
  return Math.min(MAX, Math.max(MIN, n));
}

/** The caps in force for a tenant (algo-config; code defaults 2 and 5). */
export async function bookingLimitsFor(prisma: PrismaClient, tenantId: string): Promise<BookingLimits> {
  const [perBusiness, total] = await Promise.all([
    algoValue(prisma, 'booking.maxLivePerBusiness', tenantId),
    algoValue(prisma, 'booking.maxLiveTotal', tenantId),
  ]);
  return {
    perBusiness: clamp(perBusiness, ALGO_DEFAULTS['booking.maxLivePerBusiness']),
    total: clamp(total, ALGO_DEFAULTS['booking.maxLiveTotal']),
  };
}
