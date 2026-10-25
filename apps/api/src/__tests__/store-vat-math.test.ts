import { describe, it, expect } from 'vitest';
import { orderVat, vatInsideWhole } from '../modules/store-vat/vat-math';
import { STORE_VAT_FRACTION, STORE_VAT_RATE_BPS, STORE_VAT_RATE_PERCENT } from '../modules/store-vat/vat-rate';
import { STORE_VAT_MODES_OFFERED, storeVatEffective, storeVatEnabled } from '../modules/store-vat/store-vat';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The VAT arithmetic and the ONE predicate, pure.
// Law (GRA primary sources, cited in vat-rate.ts): 14% (VAT Regulations reg. 2), tax fraction R/(1+R) = 14/114 = 7/57
// (Act s.2, GRA Policy #25: "$1000 x 7 = $7000", "$7000/57 = $123"). Swift's rule (COORD ruling 22 Oct, accountant
// VERIFY V3): ONE amount per order, half-up to the whole GYD, from the exact fraction, on the standard-rated goods
// actually charged (after the goods discount).
// ---------------------------------------------------------------------------

describe('store VAT rate (one cited module)', () => {
  it('is 14%, 1400 bps, and the fraction 14/114 (= 7/57)', () => {
    expect(STORE_VAT_RATE_PERCENT).toBe(14);
    expect(STORE_VAT_RATE_BPS).toBe(1400);
    expect(STORE_VAT_FRACTION).toEqual({ numerator: 14, denominator: 114 });
    expect(STORE_VAT_FRACTION.numerator * 57).toBe(STORE_VAT_FRACTION.denominator * 7);
  });
});

describe('vatInsideWhole: VAT inside a VAT-inclusive amount, half-up to whole GYD', () => {
  it.each([
    [1000, 123], // GRA Policy #25 worked example (exact 122.807)
    [114, 14], [57, 7], [570, 70], [2000, 246], [11_400, 1400],
    [1, 0], [4, 0], // 0.12, 0.49
    [5, 1], // 0.614
    [0, 0],
  ])('%d -> %d', (gross, vat) => {
    expect(vatInsideWhole(gross)).toBe(vat);
  });

  it('half-up at exactly .5 (28.50 -> 3.5 -> 4; 85.50 -> 10.5 -> 11), down just below it (28.49 -> 3)', () => {
    expect(vatInsideWhole(28.5)).toBe(4);
    expect(vatInsideWhole(85.5)).toBe(11);
    expect(vatInsideWhole(28.49)).toBe(3);
  });

  it('never negative, never from a non-finite amount', () => {
    expect(vatInsideWhole(-500)).toBe(0);
    expect(() => vatInsideWhole(Number.NaN)).toThrow(RangeError);
    expect(() => vatInsideWhole(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('exact integer arithmetic: no float drift on large amounts (9,999,999 -> 1,228,070)', () => {
    // 9,999,999 x 14 / 114 = 1,228,070.05...
    expect(vatInsideWhole(9_999_999)).toBe(1_228_070);
  });
});

describe('orderVat: one amount per ORDER', () => {
  it('only STANDARD goods carry VAT; zero-rated and exempt goods are reported separately (reg. 10(d))', () => {
    const r = orderVat({ lines: [
      { id: 'a', amount: 1000, vatClass: 'STANDARD' },
      { id: 'b', amount: 600, vatClass: 'ZERO_RATED' },
      { id: 'c', amount: 300, vatClass: 'EXEMPT' },
    ] });
    expect(r).toEqual({ vatAmount: 123, standardGoods: 1000, zeroRatedGoods: 600, exemptGoods: 300, vatBase: 1000, rateBps: 1400 });
  });

  it('rounds ONCE per order, never per line: three 5-dollar lines are 15 x 14/114 = 1.84 -> 2 (per line it would be 3)', () => {
    const r = orderVat({ lines: ['a', 'b', 'c'].map((id) => ({ id, amount: 5, vatClass: 'STANDARD' as const })) });
    expect(r.vatAmount).toBe(2);
  });

  it('the goods discount reduces the base by each line’s share (same largest-remainder split as the redemption)', () => {
    // 150 split over 1000 + 500 = 100 + 50; base = 1000 - 100 = 900 -> 110.53 -> 111
    const r = orderVat({ lines: [
      { id: 'std', amount: 1000, vatClass: 'STANDARD' },
      { id: 'zero', amount: 500, vatClass: 'ZERO_RATED' },
    ], goodsDiscount: 150 });
    expect(r.vatBase).toBe(900);
    expect(r.vatAmount).toBe(111);
    expect(r.standardGoods).toBe(1000);
  });

  it('stored per-line shares win over a re-derived split', () => {
    const r = orderVat({
      lines: [{ id: 'std', amount: 1000, vatClass: 'STANDARD' }, { id: 'zero', amount: 500, vatClass: 'ZERO_RATED' }],
      goodsDiscount: 150,
      lineGoodsDiscounts: new Map([['std', 0], ['zero', 150]]),
    });
    expect(r.vatBase).toBe(1000);
    expect(r.vatAmount).toBe(123);
  });

  it('a removed line (amount 0) carries nothing, and a share bigger than its line never makes the base negative', () => {
    const r = orderVat({
      lines: [{ id: 'gone', amount: 0, vatClass: 'STANDARD' }, { id: 'kept', amount: 114, vatClass: 'STANDARD' }],
      lineGoodsDiscounts: new Map([['gone', 200]]),
    });
    expect(r.vatBase).toBe(114);
    expect(r.vatAmount).toBe(14);
  });

  it('a placed order keeps the rate it froze (1250 bps: 1000 x 1250/11250 = 111.1 -> 111)', () => {
    expect(orderVat({ lines: [{ id: 'a', amount: 1000, vatClass: 'STANDARD' }], rateBps: 1250 }).vatAmount).toBe(111);
  });
});

describe('the switch and the ONE predicate', () => {
  const approved = {
    vatRegistrationNumber: '012345678', vatStatus: 'APPROVED', vatMode: 'PRICES_INCLUDE_VAT',
    vatApprovedNumber: '012345678', vatApprovedName: 'Corner Shop Inc.', vatEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
  };
  const on = { STORE_VAT: '1' };
  const now = new Date('2026-10-24T12:00:00Z');

  it('STORE_VAT is OFF unless exactly "1"', () => {
    expect(storeVatEnabled({})).toBe(false);
    expect(storeVatEnabled({ STORE_VAT: '' })).toBe(false);
    expect(storeVatEnabled({ STORE_VAT: 'true' })).toBe(false);
    expect(storeVatEnabled({ STORE_VAT: '0' })).toBe(false);
    expect(storeVatEnabled(on)).toBe(true);
  });

  it('holds for a person-approved store with the switch on', () => {
    expect(storeVatEffective(approved, on, now)).toBe(true);
  });

  it.each([
    ['switch off', approved, {}],
    ['PENDING', { ...approved, vatStatus: 'PENDING' }, on],
    ['REJECTED', { ...approved, vatStatus: 'REJECTED' }, on],
    ['REVOKED', { ...approved, vatStatus: 'REVOKED' }, on],
    ['NONE', { ...approved, vatStatus: 'NONE' }, on],
    ['no mode', { ...approved, vatMode: null }, on],
    ['add-at-checkout (not offered in this release)', { ...approved, vatMode: 'ADD_VAT_AT_CHECKOUT' }, on],
    ['store number changed since approval', { ...approved, vatRegistrationNumber: '999999999' }, on],
    ['store number taken down', { ...approved, vatRegistrationNumber: null }, on],
    ['no approved number', { ...approved, vatApprovedNumber: null }, on],
    ['no approved name', { ...approved, vatApprovedName: null }, on],
    ['certificate not yet in effect', { ...approved, vatEffectiveFrom: new Date('2026-11-01T00:00:00Z') }, on],
  ])('fails when %s', (_label, row, env) => {
    expect(storeVatEffective(row, env as Record<string, string>, now)).toBe(false);
  });

  it('this release offers only "prices already include VAT"', () => {
    expect([...STORE_VAT_MODES_OFFERED]).toEqual(['PRICES_INCLUDE_VAT']);
  });
});
