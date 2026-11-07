import { describe, expect, it } from 'vitest';
import { lastGuyanaMonth, monthPeriod, vatReportCsv, type VatReport } from './vat-report';

// [STORE-VAT · owner O-5 · PR4] The VAT report's month (a VAT return's tax period, VAT Act s.2) and its CSV for the
// accountant: the same figures the server sent, plain two-decimal amounts, quoted when needed, never a formula.

const sample: VatReport = {
  from: '2026-02-01', to: '2026-02-28',
  days: [{ day: '2026-02-03', orders: 2, standardRatedInclVat: 3280, vatCharged: 403, standardRatedExclVat: 2877, zeroRatedSales: 600, exemptSales: 500 }],
  totals: { orders: 2, standardRatedInclVat: 3280, vatCharged: 403, standardRatedExclVat: 2877, zeroRatedSales: 600, exemptSales: 500 },
  orders: [
    { orderId: 'o1', orderNumber: 'SW-1', day: '2026-02-03', ratePercent: 14, standardRatedInclVat: 1000, vatCharged: 123, standardRatedExclVat: 877, zeroRatedSales: 600, exemptSales: 0 },
    { orderId: 'o2', orderNumber: 'SW-2', day: '2026-02-03', ratePercent: 14, standardRatedInclVat: 2280, vatCharged: 280, standardRatedExclVat: 2000, zeroRatedSales: 0, exemptSales: 500 },
  ],
  returnLines: [
    { line: 15, label: 'Zero-Rated Sales', amount: 600 }, { line: 16, label: 'Exempt Sales', amount: 500 },
    { line: 17, label: 'Standard Rated Sales excluding VAT', amount: 2877 }, { line: 18, label: 'VAT charged on goods and services during this period', amount: 403 },
  ],
  sellers: [{ name: 'Shop, Ltd', vatNumber: '012345678', orders: 2 }],
  prepared: 'Prepared from your Swift orders. Your accountant files your VAT return; Swift does not file it for you.',
  notes: ['These figures cover only your sales through Swift.'],
};

describe('[O-5 PR4] the month', () => {
  it('a calendar month as Guyana days (leap years too)', () => {
    expect(monthPeriod('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthPeriod('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthPeriod('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('last month in GUYANA: at 22:00 on 28 February in Guyana (already March in UTC) it is January', () => {
    expect(lastGuyanaMonth(new Date('2026-03-01T02:00:00Z'))).toBe('2026-01');
    expect(lastGuyanaMonth(new Date('2026-03-01T04:00:00Z'))).toBe('2026-02');
    expect(lastGuyanaMonth(new Date('2026-01-15T12:00:00Z'))).toBe('2025-12');
  });
});

describe('[O-5 PR4] the CSV', () => {
  const csv = vatReportCsv(sample);
  const rows = csv.split('\r\n');

  it('says who prepared it and that the accountant files; names the seller as frozen on the orders', () => {
    expect(rows[0]).toBe('Swift VAT report');
    expect(rows).toContain('Period (Guyana days),2026-02-01,2026-02-28');
    expect(rows).toContain('VAT charged by,"Shop, Ltd",012345678,2 orders');
    expect(rows).toContain('Prepared from your Swift orders. Your accountant files your VAT return; Swift does not file it for you.');
  });

  it('the GRA return’s sales lines, each day, the total and each order, as plain two-decimal amounts', () => {
    expect(rows).toContain('15,Zero-Rated Sales,600.00');
    expect(rows).toContain('17,Standard Rated Sales excluding VAT,2877.00');
    expect(rows).toContain('18,VAT charged on goods and services during this period,403.00');
    expect(rows).toContain('2026-02-03,2,3280.00,403.00,2877.00,600.00,500.00');
    expect(rows).toContain('Total,2,3280.00,403.00,2877.00,600.00,500.00');
    expect(rows).toContain('SW-1,2026-02-03,14,1000.00,123.00,877.00,600.00,0.00');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('a name a spreadsheet would run as a formula is written as text', () => {
    const risky = vatReportCsv({ ...sample, sellers: [{ name: '=HYPERLINK("x")', vatNumber: '1', orders: 1 }] });
    expect(risky).toContain(`VAT charged by,"'=HYPERLINK(""x"")",1,1 orders`);
  });
});
