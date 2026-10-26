/**
 * [STORE-VAT · owner O-5 · PR4] The store's VAT report, for its accountant.
 *
 * Made ONLY from the VAT each order froze at checkout and kept current as its goods changed (order-vat.ts): the same
 * figures the order's receipt prints, so every order ties to a receipt. Nothing is recomputed here.
 *
 * Which orders: this store's orders that froze VAT (vatRateBps set) and were SUPPLIED, i.e. DELIVERED or COMPLETED (the
 * statuses a receipt is issued for). Each counts on the GUYANA calendar day of supply: when it was delivered; for an
 * order collected at the counter (COMPLETED with no delivery time), when it was completed (its status log); else when
 * it was placed. Guyana keeps UTC-4 all year (no daylight saving), so a Guyana day runs 04:00 to 04:00 UTC.
 *
 * How it is laid out: the sales lines of the GRA's VAT return (form G0002 v1, GRA 2020, and the GRA's online VAT return
 * page gra.gov.gy/optimal/vat, which states the same lines): line 15 zero-rated sales ("the total consideration for all
 * your zero-rated supplies"), 16 exempt sales, 17 standard-rated sales excluding VAT ("the tax-exclusive value"), 18 VAT
 * charged ("the total output tax due"). Line 19 (adjustments) and line 20 (total output VAT) stay the accountant's. VAT Act
 * Cap. 81:05 s.2 makes the tax period a calendar month and s.31(1) has the store lodge its return by the 21st of the
 * next month. Swift NEVER files: the report says so, and covers only the store's sales through Swift.
 *
 * Money: whole GYD columns summed as integer cents, never as floats.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { guyanaDayKey } from '../../utils/guyana-day';

export const VAT_REPORT_MAX_DAYS = 92;

export const VAT_REPORT_PREPARED = 'Prepared from your Swift orders. Your accountant files your VAT return; Swift does not file it for you.';

export const VAT_REPORT_NOTES: readonly string[] = [
  'These figures cover only your sales through Swift. Your accountant adds your other sales and what you bought (the return’s purchases and input VAT lines).',
  'Each order counts on the Guyana day you supplied it: delivered, or collected at your counter. Cancelled orders, and orders placed while your prices carried no VAT, are not in it.',
  'Each order’s figures are the ones its Swift receipt prints. Zero-rated and exempt sales are the goods’ prices before any discount, as on the receipts.',
  'Returns and refunds after delivery are not taken off here; your accountant records them on the return’s adjustment lines.',
  'The line numbers are those of the GRA VAT return (form G0002, and the GRA’s online VAT return page). Your accountant checks them against the form in use.',
];

/** The sales lines of the GRA VAT return (form G0002 v1) this report fills, in the form's own words. */
const RETURN_LINES = [
  { line: 15, label: 'Zero-Rated Sales', key: 'zeroRatedSales' },
  { line: 16, label: 'Exempt Sales', key: 'exemptSales' },
  { line: 17, label: 'Standard Rated Sales excluding VAT', key: 'standardRatedExclVat' },
  { line: 18, label: 'VAT charged on goods and services during this period', key: 'vatCharged' },
] as const;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function rangeError(message: string): AppError {
  return new AppError(400, 'VAT_REPORT_RANGE', message);
}

/** 00:00 Guyana time on a Guyana calendar day, as an instant (UTC-4, no daylight saving). */
function guyanaMidnight(dayKey: string): Date {
  return new Date(`${dayKey}T04:00:00.000Z`);
}

function realDay(key: string): boolean {
  if (!DATE_KEY.test(key)) return false;
  const d = new Date(`${key}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

/** The report's period: whole Guyana days, `from` to `to` inclusive, at most VAT_REPORT_MAX_DAYS. */
export function vatReportRange(from: string, to: string): { from: string; to: string; start: Date; end: Date } {
  if (!realDay(from) || !realDay(to)) throw rangeError('Choose the first and last day as dates (YYYY-MM-DD).');
  if (from > to) throw rangeError('The last day is before the first day.');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (days > VAT_REPORT_MAX_DAYS) throw rangeError(`Choose at most ${VAT_REPORT_MAX_DAYS} days (a VAT return covers one month).`);
  return { from, to, start: guyanaMidnight(from), end: new Date(guyanaMidnight(to).getTime() + DAY_MS) };
}

/** When the store supplied the goods: delivered, else completed at the counter, else placed. */
export function supplyInstant(o: { deliveredAt: Date | null; completedAt: Date | null; placedAt: Date }): Date {
  return o.deliveredAt ?? o.completedAt ?? o.placedAt;
}

export interface VatReportRow {
  id: string;
  orderNumber: string;
  vatRateBps: number;
  vatBase: unknown;
  vatAmount: unknown;
  vatZeroRatedGoods: unknown;
  vatExemptGoods: unknown;
  vatSellerName: string | null;
  vatSellerNumber: string | null;
  /** The Guyana day of supply (supplyInstant). */
  supplyDay: string;
}

interface Figures {
  standardRatedInclVat: number;
  vatCharged: number;
  standardRatedExclVat: number;
  zeroRatedSales: number;
  exemptSales: number;
}

const cents = (v: unknown): number => Math.round((Number(v ?? 0) || 0) * 100);

class Sum {
  orders = 0;
  incl = 0; vat = 0; zero = 0; exempt = 0;
  add(r: VatReportRow): void {
    this.orders += 1;
    this.incl += cents(r.vatBase); this.vat += cents(r.vatAmount); this.zero += cents(r.vatZeroRatedGoods); this.exempt += cents(r.vatExemptGoods);
  }
  figures(): Figures {
    return {
      standardRatedInclVat: this.incl / 100, vatCharged: this.vat / 100, standardRatedExclVat: (this.incl - this.vat) / 100,
      zeroRatedSales: this.zero / 100, exemptSales: this.exempt / 100,
    };
  }
}

export interface VatReport {
  from: string;
  to: string;
  days: Array<{ day: string; orders: number } & Figures>;
  totals: { orders: number } & Figures;
  orders: Array<{ orderId: string; orderNumber: string; day: string; ratePercent: number } & Figures>;
  returnLines: Array<{ line: number; label: string; amount: number }>;
  sellers: Array<{ name: string | null; vatNumber: string | null; orders: number }>;
  prepared: string;
  notes: readonly string[];
}

/** The report from the frozen per-order VAT, pure. */
export function buildVatReport(rows: readonly VatReportRow[], from: string, to: string): VatReport {
  const sorted = [...rows].sort((a, b) => (a.supplyDay === b.supplyDay ? a.orderNumber.localeCompare(b.orderNumber) : a.supplyDay < b.supplyDay ? -1 : 1));
  const total = new Sum();
  const byDay = new Map<string, Sum>();
  const sellers = new Map<string, { name: string | null; vatNumber: string | null; orders: number }>();
  const orders: VatReport['orders'] = [];
  for (const r of sorted) {
    total.add(r);
    const day = byDay.get(r.supplyDay) ?? new Sum();
    day.add(r);
    byDay.set(r.supplyDay, day);
    const one = new Sum();
    one.add(r);
    orders.push({ orderId: r.id, orderNumber: r.orderNumber, day: r.supplyDay, ratePercent: r.vatRateBps / 100, ...one.figures() });
    const sellerKey = `${r.vatSellerName ?? ''}\u0000${r.vatSellerNumber ?? ''}`;
    const seller = sellers.get(sellerKey) ?? { name: r.vatSellerName, vatNumber: r.vatSellerNumber, orders: 0 };
    seller.orders += 1;
    sellers.set(sellerKey, seller);
  }
  const totals = { orders: total.orders, ...total.figures() };
  return {
    from, to,
    days: [...byDay.entries()].map(([day, s]) => ({ day, orders: s.orders, ...s.figures() })),
    totals,
    orders,
    returnLines: RETURN_LINES.map((l) => ({ line: l.line, label: l.label, amount: totals[l.key] })),
    sellers: [...sellers.values()],
    prepared: VAT_REPORT_PREPARED,
    notes: VAT_REPORT_NOTES,
  };
}

/** Orders a single report may hold before the store is asked for a shorter period. */
const MAX_ORDERS = 20_000;

/** The store's VAT report for `from`..`to` (Guyana days), from its own supplied VAT orders only. */
export async function storeVatReport(db: PrismaClient | Prisma.TransactionClient, vendorId: string, from: string, to: string): Promise<VatReport> {
  const range = vatReportRange(from, to);
  const window = { gte: range.start, lt: range.end };
  const found = await db.order.findMany({
    where: {
      vendorId,
      vatRateBps: { not: null },
      status: { in: ['DELIVERED', 'COMPLETED'] },
      OR: [
        { deliveredAt: window },
        { deliveredAt: null, statusHistory: { some: { status: 'COMPLETED', createdAt: window } } },
        { deliveredAt: null, statusHistory: { none: { status: 'COMPLETED' } }, placedAt: window },
      ],
    },
    select: {
      id: true, orderNumber: true, vatRateBps: true, vatBase: true, vatStandardGoods: true, vatAmount: true,
      vatZeroRatedGoods: true, vatExemptGoods: true, vatSellerName: true, vatSellerNumber: true, deliveredAt: true, placedAt: true,
      statusHistory: { where: { status: 'COMPLETED' }, select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
    orderBy: { placedAt: 'asc' },
    take: MAX_ORDERS + 1,
  });
  if (found.length > MAX_ORDERS) throw rangeError('That period has too many orders for one report. Choose a shorter period.');
  const rows = found.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    vatRateBps: o.vatRateBps!,
    // The base the VAT was taken from; an order frozen before the base was kept falls back to its standard-rated goods.
    vatBase: o.vatBase ?? o.vatStandardGoods,
    vatAmount: o.vatAmount,
    vatZeroRatedGoods: o.vatZeroRatedGoods,
    vatExemptGoods: o.vatExemptGoods,
    vatSellerName: o.vatSellerName,
    vatSellerNumber: o.vatSellerNumber,
    supplyDay: guyanaDayKey(supplyInstant({ deliveredAt: o.deliveredAt, completedAt: o.statusHistory[0]?.createdAt ?? null, placedAt: o.placedAt })),
  }));
  // [REVIEW-M #2109 S4] The query window is a coarse cut (any COMPLETED row inside it); the order's ONE supply day is the
  // first completion. Keep exactly the orders whose supply day falls in the period, so an order counts once, on that day.
  return buildVatReport(rows.filter((r) => r.supplyDay >= range.from && r.supplyDay <= range.to), range.from, range.to);
}
