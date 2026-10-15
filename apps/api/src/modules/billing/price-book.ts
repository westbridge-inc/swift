import type { PrismaClient, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · research F2 · GUARDRAILS §7 standing rule]
// A weekly price in the USD price book never changes at once.
//
//   - A HIGHER price (or a first price for a plan) is set with an
//     effectiveFrom at least PRICE_BOOK_NOTICE_DAYS (14) days ahead; anything
//     sooner is refused. A LOWER one may start now, i.e. from each partner's
//     next billing week (coordinator ruling 15 Oct). The price in force until
//     then stays in force (the book keeps both rows; neither is deleted).
//   - Every partner whose fee it changes is told in the app (inbox + push),
//     with the new amount and the date, when it is set; a notice that could
//     not be delivered is retried by the daily notice job.
//   - A week is priced by the book in force when THAT WEEK STARTS: a week that
//     began before the new price (paid, or still owed) keeps the old price.
//     Never retroactive.
//   - A week is charged a price HIGHER than the one that partner last paid
//     only if their notice of it reached them at least 14 days before the
//     week starts; otherwise it keeps the price before it, every week until
//     then (priceBookChargeFor). A lower price needs no wait.
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

export type PriceBookChargeVia = 'IN_FORCE' | 'TOLD' | 'LOWER' | 'KEPT';

/** [F2 · GUARDRAILS §7 · REVIEW-G S2-1] The price-book price a week may be
 *  charged. The rows of this partner's plan since the price they last paid
 *  are taken oldest first: a row no higher than the price reached so far
 *  applies at once (a decrease needs no wait, coordinator ruling 15 Oct; it is
 *  still told), a higher one only if this partner was told of that very row
 *  14 days before the week starts. A rise not told in time is checked again
 *  EVERY week until it is charged, not only in the first week after it takes
 *  effect, so a partner never told keeps the price they last paid.
 *
 *  The price last paid is found on the plan's rows by the USD amount the last
 *  charge recorded. A last charge with no USD amount (a legacy GYD charge) or
 *  one not on this plan's rows falls back to the row in force at that charge.
 *  No row in force then = a first price for the plan: charged as in force
 *  (the FX/migration notice rule applies to it). */
export async function priceBookChargeFor(
  rows: PriceBookRow[], role: string, tier: string, weekStart: Date,
  last: { amountUsd: number | null; createdAt: Date },
  deliveredAt: (entryId: string) => Promise<Date | null | undefined>,
): Promise<{ row: PriceBookRow; amountUsd: number; via: PriceBookChargeVia } | undefined> {
  const inForce = rowFor(rows, role, tier, weekStart);
  if (!inForce) return undefined;
  // The plan's rows back from the one in force, newest first (each strictly earlier).
  const chain: PriceBookRow[] = [];
  for (let r: PriceBookRow | undefined = inForce; r; r = rowFor(rows, role, tier, new Date(r.effectiveFrom.getTime() - 1))) chain.push(r);
  let paid = last.amountUsd === null ? -1 : chain.findIndex((r) => r.amountUsd === last.amountUsd);
  if (paid < 0) paid = chain.findIndex((r) => r.effectiveFrom.getTime() <= last.createdAt.getTime());
  if (paid <= 0) return { row: inForce, amountUsd: inForce.amountUsd, via: 'IN_FORCE' };
  let current = chain[paid]!;
  let via: PriceBookChargeVia = 'KEPT';
  for (const r of chain.slice(0, paid).reverse()) {
    if (r.amountUsd <= current.amountUsd) { current = r; via = 'LOWER'; continue; }
    if (toldInTime(await deliveredAt(r.id), weekStart)) { current = r; via = 'TOLD'; }
  }
  return { row: current, amountUsd: current.amountUsd, via };
}
