import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { color } from '@swift/ui';
import { renderReceiptHtml } from '../modules/order/receipt';
import { renderStatementHtml } from '../modules/order/statement';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · brand colour, 30 Oct 2026] Swift's brand colour is maroon #803B3B (deep #5C2A2C), as in the shipped
// app icon and the @swift/ui tokens. The receipt and the earnings statements still printed the "Swift" name in the
// old bright red (E8 19 2C). Their `.brand` rule now reads the brand token, and the old red is gone from the API's and
// the admin's source with ONE logged exception: the legal pages. Their .brand colour sits inside the HTML the consent
// ledger hashes, so changing it needs a LEGAL_VERSION bump; COORD ruled (30 Oct) not to bump for a colour. It rides
// along with the next MATERIAL legal version change.
// ---------------------------------------------------------------------------

const OLD_RED = ['E8', '19', '2C'].join(''); // split so this file never matches its own census

/** The colour in a page's `.brand { color: … }` rule, lower-cased. */
function brandColour(html: string): string {
  const rule = /\.brand\s*\{\s*color:\s*(#[0-9a-fA-F]{6})\s*;/.exec(html);
  expect(rule, 'the page has a .brand colour rule').not.toBeNull();
  return rule![1]!.toLowerCase();
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const BRAND = color.brand[500].toLowerCase();

const receipt = renderReceiptHtml({
  orderNumber: 'SW-1', status: 'DELIVERED', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', fulfillment: 'DELIVERY', placedAt: new Date('2026-09-01T12:00:00Z'),
  subtotalCustomer: 4300, deliveryFee: 500, tipAmount: 200, discount: 0, totalAmount: 5000, deliveryAddress: 'Home', deliveryFeeSource: null,
  vendor: { name: 'Store', addressLine1: '1 Main', city: 'Town', phone: '+1' }, customer: { firstName: 'A', lastName: 'B' },
  items: [{ name: 'Kettle', quantity: 1, totalCustomer: 4300 }],
} as never);
const statement = renderStatementHtml({ currencyCode: 'GYD', title: 'Earnings', holder: 'X', periodLabel: 'Sep', lines: [{ date: new Date('2026-09-02T12:00:00Z'), label: 'SW-1 · delivery fee', amount: 700 }], totalLabel: 'Total', totalAmount: 700, footNote: '' });

const PAGES: Record<string, string> = { receipt, statement };

describe('the API pages print "Swift" in the brand maroon, never the old bright red', () => {
  it('the brand token is the maroon of the shipped app icon', () => {
    expect(BRAND).toBe('#803b3b');
    expect(color.brand[600].toLowerCase()).toBe('#5c2a2c');
  });

  for (const [name, html] of Object.entries(PAGES)) {
    it(`${name}: the .brand rule is the brand colour, and the old red appears nowhere`, () => {
      expect(brandColour(html)).toBe(BRAND);
      expect(html.toUpperCase()).not.toContain(`#${OLD_RED}`);
    });
  }

  it('the maroon "Swift" stays readable: at least 4.5:1 on the white sheet (WCAG AA for normal text)', () => {
    // Both pages draw the .brand line on a white sheet.
    expect(receipt).toMatch(/\.sheet \{[^}]*background: #fff;/);
    expect(statement).toMatch(/\.sheet \{[^}]*background: #fff;/);
    expect(contrast(BRAND, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('census: the old bright red is gone from the API and admin source', () => {
  const ROOT = path.resolve(__dirname, '../../../..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|css)$/.test(entry)) out.push(p);
    }
    return out;
  };

  // The one exception, logged as a rider for the next MATERIAL legal version (COORD ruling 30 Oct 2026).
  const LEGAL_RIDER = 'apps/api/src/modules/legal/legal.routes.ts';

  it('no file under apps/api/src or apps/admin/src names the old red, except the legal pages (rider)', () => {
    const hits = [path.join(ROOT, 'apps/api/src'), path.join(ROOT, 'apps/admin/src')]
      .flatMap((d) => walk(d))
      .filter((f) => readFileSync(f, 'utf8').toUpperCase().includes(OLD_RED))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([LEGAL_RIDER]);
  });
});
