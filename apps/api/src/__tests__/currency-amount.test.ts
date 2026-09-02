import { describe, it, expect } from 'vitest';
import {
  MAJOR_AMOUNT_CEILING, currencyInfo, formatAmount, formatMoney, fromMajor, fromMinor, fromProviderMinor, isKnownCurrency, registerCurrency, toMajorNumber, toMajorString, toProviderMinor, addAmounts,
} from '../utils/currency-amount';
import { moneyBoundaryCounter } from '../plugins/observability';
import { zMoneyMinor, zMoneyWhole, MONEY_MAX_WHOLE } from '../utils/money-schema';
import { renderReceiptHtml } from '../modules/order/receipt';
import { renderStatementHtml } from '../modules/order/statement';
import { computeRefund } from '../utils/refund';
import { gyd } from '../utils/explain-earning';
import { ADS_CURRENCY_MINOR_SCALE, majorDecimalToMinor, minorToMajorString } from '../modules/ads/ads-money';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [M-36] Money unit and currency presentation contracts conflict.
//
// The register's red test: the ISO exponent / currency matrix across the
// quote, the order, billing, ads, the refund, the receipt and the statement.
// One registry, one amount type, adapters at the boundary — a value can no
// longer be 100× wrong, rounded inconsistently, or labeled GYD when it is not.
// ---------------------------------------------------------------------------

const MARKETS = ['GYD', 'USD', 'TTD', 'JMD', 'BBD', 'XCD'] as const;
const counter = async (event: string, boundary: string) => (await moneyBoundaryCounter.get()).values.find((v) => v.labels['event'] === event && v.labels['boundary'] === boundary)?.value ?? 0;

describe('the registry and the amount', () => {
  it('every market currency is registered with its ISO exponent and its own symbol; an unregistered code answers with a counted fallback, never GYD', async () => {
    for (const code of MARKETS) {
      expect(isKnownCurrency(code)).toBe(true);
      expect(currencyInfo(code)).toMatchObject({ code, exponent: 2 });
      expect(currencyInfo(code).symbol).not.toBe('');
    }
    expect(currencyInfo('TTD').symbol).toBe('TT$');
    expect(currencyInfo('GYD').symbol).toBe('GY$');
    const before = await counter('unknown_currency', 'QQQ');
    expect(currencyInfo('QQQ')).toMatchObject({ code: 'QQQ', exponent: 2, symbol: 'QQQ ' });
    expect(await counter('unknown_currency', 'QQQ')).toBe(before + 1);
  });
  it('major ↔ minor round-trips exactly in every market, with bigint minor units and no float', () => {
    for (const code of MARKETS) {
      const a = fromMajor('1234.56', code);
      expect(a).toEqual({ currency: code, exponent: 2, minor: 123456n });
      expect(toMajorString(a)).toBe('1234.56');
      expect(toMajorNumber(a)).toBe(1234.56);
      expect(fromMajor(1500, code).minor).toBe(150000n);
      expect(fromMinor(150000n, code)).toEqual(fromMajor(1500, code));
      expect(fromMinor(7, code).minor).toBe(7n);
      expect(toMajorString(fromMinor(7, code))).toBe('0.07');
      expect(addAmounts(fromMajor('0.10', code), fromMajor('0.20', code)).minor).toBe(30n); // never 0.30000000000000004
    }
    expect(fromMajor('-12.5', 'GYD').minor).toBe(-1250n);
    expect(toMajorString(fromMajor('-12.5', 'GYD'))).toBe('-12.50');
  });
  it('a zero-exponent currency has no fractional digits anywhere; a fraction beyond the exponent is refused, not rounded', () => {
    registerCurrency({ code: 'ZZ0', exponent: 0, symbol: 'Z', name: 'zero-exponent test unit' });
    expect(fromMajor(1250, 'ZZ0')).toEqual({ currency: 'ZZ0', exponent: 0, minor: 1250n });
    expect(toMajorString(fromMinor(1250, 'ZZ0'))).toBe('1250');
    expect(toProviderMinor(1250, 'ZZ0', 'test')).toBe(1250);
    expect(() => fromMajor('12.5', 'ZZ0')).toThrow(/at most 0 fractional/);
    expect(() => fromMajor('12.555', 'GYD')).toThrow(/at most 2 fractional/);
    expect(fromMajor('12.500', 'GYD').minor).toBe(1250n); // trailing zeros are not precision
    expect(() => fromMajor(NaN, 'GYD')).toThrow(/finite/);
    expect(() => fromMajor('twelve', 'GYD')).toThrow(/Invalid decimal/);
    expect(() => fromMinor(1.5, 'GYD')).toThrow(/safe integer/);
  });
  it('the human string: symbol, grouped digits, fractional digits only when present, the ISO code when asked', () => {
    expect(formatAmount(fromMajor(1500, 'GYD'))).toBe('GY$1,500');
    expect(formatAmount(fromMajor('1500.50', 'GYD'), { code: true })).toBe('GY$1,500.50 GYD');
    expect(formatAmount(fromMajor(2000, 'TTD'), { code: true })).toBe('TT$2,000 TTD');
    expect(formatAmount(fromMajor(-45, 'JMD'))).toBe('−J$45');
    expect(formatMoney(4300, 'BBD')).toBe('Bds$4,300');
    expect(formatMoney('4300.00', 'XCD', { code: true })).toBe('EC$4,300 XCD');
    expect(formatMoney(null, 'GYD')).toBe('GY$0');
    expect(formatMoney(12.345, 'USD')).toBe('US$12.35'); // a stored 2dp figure renders at its exponent
    expect(formatMoney(1234.4, 'GYD', { whole: true })).toBe('GY$1,234'); // a MAJOR_WHOLE column renders at its declared unit, rounded once here
    expect(formatMoney(1234.5, 'GYD', { whole: true })).toBe('GY$1,235');
  });
});

describe('the boundary adapters — the only place a unit changes', () => {
  it('to a provider: minor units by the registry exponent; a major amount that already looks minor-scaled is refused and counted', async () => {
    expect(toProviderMinor(12.5, 'GYD', 'test.charge')).toBe(1250);
    expect(toProviderMinor(1500, 'USD', 'test.charge')).toBe(150000);
    expect(toProviderMinor(0, 'GYD', 'test.charge')).toBe(0);
    const before = await counter('scale_anomaly', 'test.charge');
    expect(() => toProviderMinor(MAJOR_AMOUNT_CEILING, 'GYD', 'test.charge')).toThrow(/looks minor-scaled/);
    expect(() => toProviderMinor(MAJOR_AMOUNT_CEILING * 100, 'GYD', 'test.charge')).toThrow(/looks minor-scaled/);
    // Honest limit: a 100× error on a small charge (1,500 → 150,000) is indistinguishable from a large legitimate one — the adapter is the structural fix; the ceiling is a belt.
    expect(await counter('scale_anomaly', 'test.charge')).toBe(before + 2);
    expect(() => toProviderMinor(-1, 'GYD', 'test.charge')).toThrow(/non-negative/);
    expect(() => toProviderMinor(NaN, 'GYD', 'test.charge')).toThrow(/finite/);
  });
  it('from a provider: back to the major number exactly', () => {
    expect(fromProviderMinor(1250, 'GYD', 'test.webhook')).toBe(12.5);
    expect(fromProviderMinor('150000', 'USD', 'test.webhook')).toBe(1500);
    expect(fromProviderMinor(1250, 'ZZ0', 'test.webhook')).toBe(1250);
    for (const code of MARKETS) for (const major of [0, 1, 99.99, 1500, 123456.78]) {
      expect(fromProviderMinor(toProviderMinor(major, code, 't'), code, 't')).toBe(major);
    }
  });
  it('ads billing agrees with the registry in every ads currency', () => {
    for (const code of Object.keys(ADS_CURRENCY_MINOR_SCALE)) {
      expect(currencyInfo(code).exponent).toBe(ADS_CURRENCY_MINOR_SCALE[code as keyof typeof ADS_CURRENCY_MINOR_SCALE]);
      expect(majorDecimalToMinor('12.34', code)).toBe(fromMajor('12.34', code).minor);
      expect(minorToMajorString(123456n, code)).toBe(toMajorString(fromMinor(123456n, code)));
    }
    expect(() => majorDecimalToMinor('1', 'QQQ')).toThrow(/Unsupported ads currency/);
  });
  it('the client-money schema names its unit: whole major units, integers only; the old name is the same schema', () => {
    expect(zMoneyWhole.safeParse(1500).success).toBe(true);
    expect(zMoneyWhole.safeParse(12.5).success).toBe(false);
    expect(zMoneyWhole.safeParse(-1).success).toBe(false);
    expect(zMoneyWhole.safeParse(MONEY_MAX_WHOLE + 1).success).toBe(false);
    expect(zMoneyMinor).toBe(zMoneyWhole);
    expect(MONEY_MAX_WHOLE).toBe(MAJOR_AMOUNT_CEILING);
  });
});

describe('the presentation boundary: receipt, statement, refund, earnings — the order’s currency, never a hard-coded GYD', () => {
  const order = {
    orderNumber: 'SW-1', status: 'DELIVERED', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', fulfillment: 'DELIVERY', placedAt: new Date('2026-09-01T12:00:00Z'),
    subtotalCustomer: 4300, deliveryFee: 500, tipAmount: 200, discount: 0, totalAmount: 5000, deliveryAddress: 'Home', deliveryFeeSource: null,
    vendor: { name: 'Store', addressLine1: '1 Main', city: 'Town', phone: '+1' }, customer: { firstName: 'A', lastName: 'B' },
    items: [{ name: 'Kettle', quantity: 1, totalCustomer: 4300 }],
  };
  it('the receipt renders in the order’s currency across the matrix', () => {
    for (const code of MARKETS) {
      const html = renderReceiptHtml({ ...order, currencyCode: code } as never);
      expect(html).toContain(`${currencyInfo(code).symbol}5,000 ${code}`);
      if (code !== 'GYD') expect(html).not.toContain('GYD');
    }
    // legacy rows without the column: the platform default, said explicitly
    expect(renderReceiptHtml(order as never)).toContain('GY$5,000 GYD');
  });
  it('the statement renders in its own currency', () => {
    for (const code of MARKETS) {
      const html = renderStatementHtml({ currencyCode: code, title: 'Earnings', holder: 'X', periodLabel: 'Sep', lines: [{ date: new Date(), label: 'SW-1 · delivery fee', amount: 700 }], totalLabel: 'Total', totalAmount: 700, footNote: '' });
      expect(html).toContain(`${currencyInfo(code).symbol}700 ${code}`);
    }
  });
  it('the refund sentence and the earnings sentence carry the currency', () => {
    for (const code of MARKETS) {
      const r = computeRefund({ paymentMethod: 'CASH', status: 'DELIVERED', deliveryFee: 500, discount: 0, totalAmount: 4800, deliveryHappened: true, lines: [{ totalCustomer: 1200, affected: true }], currencyCode: code });
      expect(r.sentence).toContain(`${currencyInfo(code).symbol}1,200`);
      expect(gyd(700, code)).toBe(`${currencyInfo(code).symbol}700`);
    }
    expect(gyd(700)).toBe('GY$700');
  });
});

describe('the order carries its currency (source pins)', () => {
  const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('checkout stamps the buyer’s market currency, a ride request stamps the estimate’s, the Stripe and MMG adapters scale through the registry', () => {
    expect(src('modules/order/order.service.ts')).toContain('currencyCode: orderCurrency,');
    expect(src('modules/rides/rides.service.ts')).toContain('currencyCode: estimate.currencyCode,');
    const stripe = src('providers/payment/payment-provider.ts');
    expect(stripe).toContain("toProviderMinor(input.amount, input.currencyCode, 'stripe.charge')");
    expect(stripe).toContain("toProviderMinor(input.amount, input.currencyCode, 'stripe.refund')");
    expect(stripe).not.toContain('input.amount * 100');
    const mmg = src('providers/mmg/mmg-provider.ts');
    expect(mmg).not.toContain('/ 100');
    expect(mmg).not.toContain('n * 100');
    expect(src('modules/order/receipt.ts')).not.toContain('} GYD`');
    expect(src('modules/order/statement.ts')).not.toContain('} GYD`');
  });
});
