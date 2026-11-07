import { describe, it, expect } from 'vitest';
import { buildVatReport, supplyInstant, vatReportRange, VAT_REPORT_PREPARED, VAT_REPORT_MAX_DAYS } from '../modules/store-vat/vat-report';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5 · PR4] The store's VAT report, pure. It is made ONLY from the VAT each order froze (the same
// figures its receipt prints), grouped by the GUYANA day the store supplied the goods, and laid out as the sales lines
// of the GRA's VAT return (form G0002: line 15 zero-rated sales, 16 exempt sales, 17 standard-rated sales excluding
// VAT, 18 VAT charged). Swift never files a return: the report says the store's accountant does.
// ---------------------------------------------------------------------------

const row = (over: Partial<Parameters<typeof buildVatReport>[0][number]> = {}) => ({
  id: 'o1', orderNumber: 'SW-1', vatRateBps: 1400,
  vatBase: 1000, vatAmount: 123, vatZeroRatedGoods: 600, vatExemptGoods: 0,
  vatSellerName: 'Shop Ltd', vatSellerNumber: '012345678',
  supplyDay: '2026-03-02',
  ...over,
});

describe('the period (Guyana calendar days)', () => {
  it('runs from 00:00 Guyana time on the first day to 00:00 Guyana time after the last (Guyana keeps UTC-4, no DST)', () => {
    const r = vatReportRange('2026-03-01', '2026-03-31');
    expect(r.start.toISOString()).toBe('2026-03-01T04:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('refuses a malformed date, an end before the start, and a span longer than the cap', () => {
    expect(() => vatReportRange('2026-3-1', '2026-03-31')).toThrow(expect.objectContaining({ code: 'VAT_REPORT_RANGE' }));
    expect(() => vatReportRange('2026-03-31', '2026-03-01')).toThrow(expect.objectContaining({ code: 'VAT_REPORT_RANGE' }));
    expect(() => vatReportRange('2026-02-30', '2026-03-01')).toThrow(expect.objectContaining({ code: 'VAT_REPORT_RANGE' }));
    expect(VAT_REPORT_MAX_DAYS).toBe(92);
    expect(() => vatReportRange('2026-01-01', '2026-04-02')).not.toThrow(); // 92 days
    expect(() => vatReportRange('2026-01-01', '2026-04-03')).toThrow(expect.objectContaining({ code: 'VAT_REPORT_RANGE' }));
  });

  it('the supply moment: delivered, else completed at the counter, else placed', () => {
    const placed = new Date('2026-03-01T12:00:00Z');
    expect(supplyInstant({ deliveredAt: new Date('2026-03-02T01:00:00Z'), completedAt: null, placedAt: placed })?.toISOString()).toBe('2026-03-02T01:00:00.000Z');
    expect(supplyInstant({ deliveredAt: null, completedAt: new Date('2026-03-03T15:00:00Z'), placedAt: placed })?.toISOString()).toBe('2026-03-03T15:00:00.000Z');
    expect(supplyInstant({ deliveredAt: null, completedAt: null, placedAt: placed })?.toISOString()).toBe(placed.toISOString());
  });
});

describe('the report', () => {
  const report = buildVatReport([
    row({ id: 'a', orderNumber: 'SW-A', supplyDay: '2026-02-28' }),
    row({ id: 'b', orderNumber: 'SW-B', vatBase: 2280, vatAmount: 280, vatZeroRatedGoods: 0, vatExemptGoods: 500, supplyDay: '2026-03-02' }),
    row({ id: 'c', orderNumber: 'SW-C', vatBase: 0.5, vatAmount: 0, vatZeroRatedGoods: 0.25, vatExemptGoods: 0.25, supplyDay: '2026-03-02' }),
  ], '2026-02-28', '2026-03-31');

  it('one row per Guyana day with orders, in order; the figures of that day’s orders', () => {
    expect(report.days.map((d) => d.day)).toEqual(['2026-02-28', '2026-03-02']);
    expect(report.days[1]).toEqual({
      day: '2026-03-02', orders: 2,
      standardRatedInclVat: 2280.5, vatCharged: 280, standardRatedExclVat: 2000.5, zeroRatedSales: 0.25, exemptSales: 500.25,
    });
  });

  it('totals add exactly (cents, never float drift) and standard-rated sales excluding VAT = including VAT - VAT', () => {
    expect(report.totals).toEqual({
      orders: 3, standardRatedInclVat: 3280.5, vatCharged: 403, standardRatedExclVat: 2877.5, zeroRatedSales: 600.25, exemptSales: 500.25,
    });
  });

  it('every order is listed with the figures its receipt prints, so each one ties to a receipt', () => {
    expect(report.orders[0]).toEqual({
      orderId: 'a', orderNumber: 'SW-A', day: '2026-02-28', ratePercent: 14,
      standardRatedInclVat: 1000, vatCharged: 123, standardRatedExclVat: 877, zeroRatedSales: 600, exemptSales: 0,
    });
  });

  it('lays the totals out as the sales lines of the GRA return (form G0002), and says who files', () => {
    expect(report.returnLines).toEqual([
      { line: 15, label: 'Zero-Rated Sales', amount: 600.25 },
      { line: 16, label: 'Exempt Sales', amount: 500.25 },
      { line: 17, label: 'Standard Rated Sales excluding VAT', amount: 2877.5 },
      { line: 18, label: 'VAT charged on goods and services during this period', amount: 403 },
    ]);
    expect(report.prepared).toBe(VAT_REPORT_PREPARED);
    expect(VAT_REPORT_PREPARED).toBe('Prepared from your Swift orders. Your accountant files your VAT return; Swift does not file it for you.');
    expect(report.notes.join(' ')).toMatch(/only your sales through Swift/);
    expect(report.notes.join(' ')).toMatch(/returns and refunds after delivery are not taken off/i);
  });

  it('the seller as each order froze it, once per name and number', () => {
    expect(report.sellers).toEqual([{ name: 'Shop Ltd', vatNumber: '012345678', orders: 3 }]);
    const changed = buildVatReport([row(), row({ id: 'z', vatSellerNumber: '999999999' })], '2026-03-01', '2026-03-31');
    expect(changed.sellers).toEqual([{ name: 'Shop Ltd', vatNumber: '012345678', orders: 1 }, { name: 'Shop Ltd', vatNumber: '999999999', orders: 1 }]);
  });

  it('an empty period is all zeros, never missing', () => {
    const empty = buildVatReport([], '2026-03-01', '2026-03-31');
    expect(empty.days).toEqual([]);
    expect(empty.totals).toEqual({ orders: 0, standardRatedInclVat: 0, vatCharged: 0, standardRatedExclVat: 0, zeroRatedSales: 0, exemptSales: 0 });
  });

  it('never says Swift files, and never calls anything a tax invoice', () => {
    const words = [report.prepared, ...report.notes].join(' ').toLowerCase();
    expect(words).not.toContain('tax invoice');
    expect(words).not.toMatch(/swift (files|will file|submits)/);
  });
});
