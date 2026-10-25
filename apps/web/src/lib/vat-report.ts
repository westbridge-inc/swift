import { apiFetch } from './auth';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5 · PR4] The store's VAT report, for its accountant. The server builds it from the VAT each
// order froze (the figures each receipt prints), by Guyana day, as the sales lines of the GRA VAT return (form
// G0002: 15 zero-rated, 16 exempt, 17 standard-rated excluding VAT, 18 VAT charged). Swift never files the return.
// This module only reads it and writes the same figures as a CSV the accountant can open.
// ---------------------------------------------------------------------------

export interface VatFigures {
  standardRatedInclVat: number;
  vatCharged: number;
  standardRatedExclVat: number;
  zeroRatedSales: number;
  exemptSales: number;
}
export interface VatReport {
  from: string;
  to: string;
  days: Array<{ day: string; orders: number } & VatFigures>;
  totals: { orders: number } & VatFigures;
  orders: Array<{ orderId: string; orderNumber: string; day: string; ratePercent: number } & VatFigures>;
  returnLines: Array<{ line: number; label: string; amount: number }>;
  sellers: Array<{ name: string | null; vatNumber: string | null; orders: number }>;
  prepared: string;
  notes: string[];
}

const V = '/api/v1/vendor';

export const getVatReport = (from: string, to: string) =>
  apiFetch(`${V}/vat/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.data as VatReport);

/** Only what the settings link needs from the store's VAT (GET /vendor/vat, owner only). */
export const getStoreVatStatus = () => apiFetch(`${V}/vat`).then((r) => (r.data as { status?: string } | undefined)?.status ?? 'NONE');

/** A VAT return covers one calendar month (VAT Act s.2 "tax period"): the month as Guyana days. */
export function monthPeriod(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Last month in Guyana (UTC-4, no daylight saving): the month a store's next return is for. */
export function lastGuyanaMonth(now: Date = new Date()): string {
  const gy = new Date(now.getTime() - 4 * 3_600_000);
  const prev = new Date(Date.UTC(gy.getUTCFullYear(), gy.getUTCMonth() - 1, 1));
  return prev.toISOString().slice(0, 7);
}

/** One CSV cell: quoted when it must be, and never read by a spreadsheet as a formula. */
function cell(value: string | number): string {
  if (typeof value === 'number') return value.toFixed(2);
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
const line = (cells: Array<string | number>) => cells.map(cell).join(',');
const FIGURES = ['standardRatedInclVat', 'vatCharged', 'standardRatedExclVat', 'zeroRatedSales', 'exemptSales'] as const;
const FIGURE_HEADS = ['Standard-rated sales incl. VAT (GYD)', 'VAT charged (GYD)', 'Standard-rated sales excl. VAT (GYD)', 'Zero-rated sales (GYD)', 'Exempt sales (GYD)'];

/** The report as CSV: who and when, the return's sales lines, each Guyana day, each order (to tie to its receipt), and
 *  the notes. Amounts are plain numbers with two decimals (no symbol, no thousands separator) so they import cleanly. */
export function vatReportCsv(r: VatReport): string {
  const rows: string[] = [
    line(['Swift VAT report']),
    line(['Period (Guyana days)', r.from, r.to]),
    ...r.sellers.map((s) => line(['VAT charged by', s.name ?? '', s.vatNumber ?? '', `${s.orders} orders`])),
    line([r.prepared]),
    '',
    line(['GRA VAT return (form G0002) line', 'Label', 'Amount (GYD)']),
    ...r.returnLines.map((l) => line([String(l.line), l.label, l.amount])),
    '',
    line(['Day', 'Orders', ...FIGURE_HEADS]),
    ...r.days.map((d) => line([d.day, String(d.orders), ...FIGURES.map((k) => d[k])])),
    line(['Total', String(r.totals.orders), ...FIGURES.map((k) => r.totals[k])]),
    '',
    line(['Order', 'Day', 'VAT rate (%)', ...FIGURE_HEADS]),
    ...r.orders.map((o) => line([o.orderNumber, o.day, String(o.ratePercent), ...FIGURES.map((k) => o[k])])),
    '',
    line(['Notes']),
    ...r.notes.map((n) => line([n])),
  ];
  return `${rows.join('\r\n')}\r\n`;
}
