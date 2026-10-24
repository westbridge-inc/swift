import { describe, it, expect } from 'vitest';
import { renderReceiptHtml } from '../modules/order/receipt';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The order receipt of a person-approved VAT store.
// Law (GRA primary sources): only the registered supplier issues a tax invoice, one per supply (VAT Act s.28(3)-(4);
// an offence otherwise, s.67(4)). So Swift's receipt is NEVER headed or called a tax invoice: it names the store as
// the one charging the VAT, with the number a person checked on its certificate, and says the store issues its own
// tax invoice (COORD ruling E(2)). Zero-rated goods are shown with their own total (reg. 10(d)). An order without
// VAT renders exactly as before VAT existed.
// ---------------------------------------------------------------------------

const base = {
  orderNumber: 'SW-20261024-0001',
  placedAt: new Date('2026-10-24T14:00:00Z'),
  status: 'DELIVERED',
  orderType: 'GROCERY_DELIVERY',
  fulfillment: 'DELIVERY',
  paymentMethod: 'CASH',
  paymentStatus: 'CAPTURED',
  subtotalCustomer: 1600,
  deliveryFee: 800,
  tipAmount: 0,
  discount: 0,
  totalAmount: 2400,
  deliveryAddress: '1 Main St, Georgetown',
  vendor: { name: 'Corner Shop', addressLine1: '2 Shop St', city: 'Georgetown', phone: '+5926000000' },
  seller: null,
  customer: { firstName: 'Ann', lastName: 'B' },
  currencyCode: 'GYD',
  items: [
    { name: 'Soap', quantity: 1, totalCustomer: 1000, vatClass: null as string | null },
    { name: 'Rice', quantity: 1, totalCustomer: 600, vatClass: null as string | null },
  ],
};

const vatOrder = {
  ...base,
  items: [
    { name: 'Soap', quantity: 1, totalCustomer: 1000, vatClass: 'STANDARD' },
    { name: 'Rice', quantity: 1, totalCustomer: 600, vatClass: 'ZERO_RATED' },
  ],
  vatRateBps: 1400,
  vatAmount: 123,
  vatStandardGoods: 1000,
  vatZeroRatedGoods: 600,
  vatExemptGoods: 0,
  vatSellerNumber: '012345678',
  vatSellerName: 'Corner Shop <Ltd> & Co',
};

const occurrences = (html: string, needle: string) => html.toLowerCase().split(needle.toLowerCase()).length - 1;

describe('an order WITHOUT VAT: exactly as before', () => {
  it('null VAT fields render byte-identically to absent ones, and the word VAT never appears', () => {
    const plain = renderReceiptHtml(base as never);
    const withNulls = renderReceiptHtml({ ...base, vatRateBps: null, vatAmount: null, vatSellerName: null, vatSellerNumber: null } as never);
    expect(withNulls).toBe(plain);
    expect(plain).not.toMatch(/VAT/);
    expect(plain).not.toMatch(/tax invoice/i);
    expect(plain).not.toMatch(/zero-rated/i);
  });
});

describe('an order of a person-approved VAT store', () => {
  const html = renderReceiptHtml(vatOrder as never);

  it('shows the VAT INCLUDED (never added: the total is unchanged) at the rate the order froze', () => {
    expect(html).toContain('<td>VAT included (14%)</td><td class="num">GY$123 GYD</td>');
    expect(html).toContain('<tr class="grand"><td>Total</td><td class="num">GY$2,400 GYD</td></tr>');
  });

  it('names the store as the one charging VAT, with the approved number, escaped', () => {
    expect(html).toContain('VAT charged by Corner Shop &lt;Ltd&gt; &amp; Co · VAT reg. no. 012345678.');
    expect(html).not.toContain('<Ltd>');
  });

  it('zero-rated goods get their own total (reg. 10(d)); each line says its class', () => {
    expect(html).toContain('<td>Standard-rated goods (incl. VAT)</td><td class="num">GY$1,000 GYD</td>');
    expect(html).toContain('<td>Zero-rated goods (no VAT)</td><td class="num">GY$600 GYD</td>');
    expect(html).not.toContain('Exempt goods'); // none on this order
    expect(html).toContain('1× Rice (zero-rated)</td>');
    expect(html).toContain('1× Soap</td>');
  });

  it('is NEVER headed or called a tax invoice: the only mention says the STORE issues its own (s.28, s.67(4))', () => {
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    const h1 = html.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? '';
    expect(title).not.toMatch(/invoice/i);
    expect(h1).not.toMatch(/invoice/i);
    expect(h1).toMatch(/^Receipt/);
    expect(occurrences(html, 'tax invoice')).toBe(1);
    expect(html).toContain('Corner Shop &lt;Ltd&gt; &amp; Co issues its own tax invoice for these goods.');
    expect(occurrences(html, 'invoice')).toBe(1);
  });

  it('a rate other than 14 is shown as frozen (1250 bps -> 12.5%)', () => {
    expect(renderReceiptHtml({ ...vatOrder, vatRateBps: 1250 } as never)).toContain('VAT included (12.5%)');
  });

  it('shows no VAT block when the frozen seller details are missing (never a VAT line without a person-approved number)', () => {
    const noNumber = renderReceiptHtml({ ...vatOrder, vatSellerNumber: null } as never);
    expect(noNumber).not.toMatch(/VAT included|VAT charged by|tax invoice/);
  });

  it('a removed line is still priced at nothing and keeps its class tag', () => {
    const removed = renderReceiptHtml({ ...vatOrder, items: [{ ...vatOrder.items[0]!, subStatus: 'REFUNDED' }, vatOrder.items[1]!] } as never);
    expect(removed).toContain('1× Soap (removed, not charged)</td>');
  });
});
