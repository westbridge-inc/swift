import { describe, expect, it } from 'vitest';
import { cancellationReasonWords } from './cancellation-words';

// [UI-SWEEP U14 · COORD ruling 21 Oct] The website never shows a raw cancellation code.
describe('cancellation reasons read as words, never as codes', () => {
  it.each(['customer', 'store'] as const)('the codes the server writes read as words for the %s', (reader) => {
    for (const code of ['NO_DRIVERS_AVAILABLE', 'FOOD_TOO_OLD']) {
      const words = cancellationReasonWords(code, reader);
      expect(words, code).toBeTruthy();
      expect(words, code).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });

  it('each reader gets its own words', () => {
    expect(cancellationReasonWords('FOOD_TOO_OLD', 'customer')).toBe('Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.');
    expect(cancellationReasonWords('FOOD_TOO_OLD', 'store')).toBe('Too old to deliver: the order was ready but no rider could be found in time.');
    expect(cancellationReasonWords('NO_DRIVERS_AVAILABLE', 'customer')).toBe('No drivers came online in time, so your request was released. Nothing to pay.');
  });

  it('a code this build does not know says nothing, so the page shows its generic line', () => {
    for (const code of ['SOME_NEW_CODE', 'X', 'MMG_NOT_PAID_IN_TIME', 'toString', 'constructor']) {
      const words = cancellationReasonWords(code, 'customer');
      expect(words === null || !/^[A-Z][A-Z0-9_]*$/.test(words), code).toBe(true);
    }
    expect(cancellationReasonWords('SOME_NEW_CODE', 'store')).toBeNull();
    expect(cancellationReasonWords('constructor', 'store')).toBe('constructor');
  });

  it('a reason already in words is shown as written', () => {
    expect(cancellationReasonWords('Kitchen is too busy', 'customer')).toBe('Kitchen is too busy');
    expect(cancellationReasonWords('  Customer changed their mind ', 'store')).toBe('Customer changed their mind');
  });

  it('no reason is nothing to say', () => {
    for (const value of [null, undefined, '', '   ', 42, {}]) expect(cancellationReasonWords(value, 'store')).toBeNull();
  });
});
