import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { MONEY_COLUMNS, MONEY_FIELD_PATTERN, moneyUnitOf } from '../utils/money-units';

// [M-36] The money-column inventory is the schema's own: every money-ish
// Decimal column in the DMMF is annotated with its unit, and nothing is
// annotated that no longer exists.
describe('money-column census', () => {
  const dmmf = Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.filter((f) => f.type === 'Decimal' && MONEY_FIELD_PATTERN.test(f.name)).map((f) => `${m.name}.${f.name}`)).sort();
  const listed = MONEY_COLUMNS.map((c) => `${c.model}.${c.field}`).sort();
  it('every money-ish Decimal column in the schema is annotated with a unit — a new one is born annotated or the build is red', () => {
    const missing = dmmf.filter((c) => !listed.includes(c));
    expect(missing, `annotate these in utils/money-units.ts: ${missing.join(', ')}`).toEqual([]);
    expect(dmmf.length).toBeGreaterThan(90);
  });
  it('nothing is annotated that the schema no longer has', () => {
    const stale = listed.filter((c) => !dmmf.includes(c));
    expect(stale, `remove these from utils/money-units.ts: ${stale.join(', ')}`).toEqual([]);
  });
  it('the units say what the readers do: USD columns are USD, rates are rates, ads and bank figures carry cents, the rest are whole major units', () => {
    expect(moneyUnitOf('BillingEvent', 'amountUsd')).toBe('USD_MAJOR');
    expect(moneyUnitOf('CountryConfig', 'usdExchangeRate')).toBe('FX_RATE');
    expect(moneyUnitOf('AdsSettings', 'platformFeePct')).toBe('PERCENT');
    expect(moneyUnitOf('AdBooking', 'amount')).toBe('MAJOR_2DP');
    expect(moneyUnitOf('SettlementBatch', 'grossGyd')).toBe('MAJOR_2DP');
    expect(moneyUnitOf('Order', 'totalAmount')).toBe('MAJOR_WHOLE');
    expect(moneyUnitOf('Earning', 'amount')).toBe('MAJOR_WHOLE');
    expect(moneyUnitOf('Nope', 'amount')).toBeNull();
  });
});
