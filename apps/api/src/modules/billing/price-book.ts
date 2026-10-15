import type { PrismaClient, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · research F2 · GUARDRAILS §7 standing rule]
// A weekly price in the USD price book never changes at once.
//
//   - A new price is set with an effectiveFrom at least PRICE_BOOK_NOTICE_DAYS
//     (14) days ahead; anything sooner is refused. The price in force until
//     then stays in force (the book keeps both rows; neither is deleted).
//   - Every partner whose fee it changes is told in the app (inbox + push),
//     with the new amount and the date, when it is set; a notice that could
//     not be delivered is retried by the daily notice job.
//   - A week is priced by the book in force when THAT WEEK STARTS: a week that
//     began before the new price (paid, or still owed) keeps the old price.
//     Never retroactive.
//   - A week is charged a new price only if that partner's notice reached
//     them at least 14 days before the week starts; otherwise it keeps the
//     price before it, and the change applies from a later week.
//
// The USD price book is dormant until usdPricingEnabled is switched on; the
// rule holds whether or not it is.
// ---------------------------------------------------------------------------

export const PRICE_BOOK_NOTICE_DAYS = 14;
const DAY_MS = 86_400_000;

export interface PriceBookRow { id: string; role: string; tier: string | null; amountUsd: number; effectiveFrom: Date }

export const priceBookKey = (role: string, tier: string | null) => `${role}|${tier ?? ''}`;
export const priceBookNoticeKey = (subscriptionId: string, entryId: string) => `pricebook-notice:${subscriptionId}:${entryId}`;

/** Every active (not superseded) row, oldest effective first. */
export async function activePriceBook(db: Pick<PrismaClient | Prisma.TransactionClient, 'priceBookEntry'>): Promise<PriceBookRow[]> {
  const rows = await db.priceBookEntry.findMany({ where: { active: true }, orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => ({ id: r.id, role: r.role, tier: r.tier, amountUsd: Number(r.amountUsd), effectiveFrom: r.effectiveFrom }));
}

/** The row in force at `asOf` for each key: the latest effectiveFrom not after it. */
export function bookRowsAt(rows: PriceBookRow[], asOf: Date): Map<string, PriceBookRow> {
  const out = new Map<string, PriceBookRow>();
  for (const row of rows) {
    if (row.effectiveFrom.getTime() > asOf.getTime()) continue;
    const key = priceBookKey(row.role, row.tier);
    const seen = out.get(key);
    if (!seen || row.effectiveFrom.getTime() >= seen.effectiveFrom.getTime()) out.set(key, row);
  }
  return out;
}

/** The book in force at `asOf` as key -> USD amount: what every reader used to build from `active` rows. */
export function bookAt(rows: PriceBookRow[], asOf: Date): Map<string, number> {
  return new Map([...bookRowsAt(rows, asOf)].map(([key, row]) => [key, row.amountUsd]));
}

/** The row a subscription's price comes from at `asOf`: its exact tier, else its role's default. */
export function rowFor(rows: PriceBookRow[], role: string, tier: string, asOf: Date): PriceBookRow | undefined {
  const inForce = bookRowsAt(rows, asOf);
  return inForce.get(priceBookKey(role, tier)) ?? inForce.get(priceBookKey(role, null));
}

/** The earliest moment a price set now may take effect. */
export function earliestPriceChange(now: Date): Date {
  return new Date(now.getTime() + PRICE_BOOK_NOTICE_DAYS * DAY_MS);
}

/** Was this partner told in time for a week starting at `weekStart`? */
export function toldInTime(deliveredAt: Date | null | undefined, weekStart: Date): boolean {
  return !!deliveredAt && deliveredAt.getTime() <= weekStart.getTime() - PRICE_BOOK_NOTICE_DAYS * DAY_MS;
}
