import { describe, expect, it } from 'vitest';
import { OrderStatus, cancellationReasonWords, storeOrderStatusWords, ORDER_CANCELLED_WORDS, STORE_ORDER_STATUS_WORDS, UNKNOWN_CANCELLATION_WORDS, UNKNOWN_STATUS_WORDS } from '@swift/types';

// [UI-SWEEP U14 · COORD rulings 21 Oct] ONE plain-words map (@swift/types order-words):
// web and phone never show a raw status or cancellation code.
const LOOKS_LIKE_A_CODE = /[A-Z]{2,}_[A-Z]|^[A-Z][A-Z0-9_]*$/;

describe('order statuses as a store reads them', () => {
  it('every status the server can send has words, and none of them is a code', () => {
    for (const status of Object.values(OrderStatus)) {
      const words = storeOrderStatusWords(status);
      expect(words, status).not.toBe(UNKNOWN_STATUS_WORDS);
      expect(words, status).not.toMatch(LOOKS_LIKE_A_CODE);
      expect(words, status).toBe(STORE_ORDER_STATUS_WORDS[status]);
    }
  });

  it('the phone board words, and the older spellings the board accepts', () => {
    expect(storeOrderStatusWords('PENDING')).toBe('New');
    expect(storeOrderStatusWords('PLACED')).toBe('New');
    expect(storeOrderStatusWords('CONFIRMED')).toBe('Accepted');
    expect(storeOrderStatusWords('READY')).toBe('Ready');
    expect(storeOrderStatusWords('ready_for_pickup')).toBe('Ready');
    expect(storeOrderStatusWords('RIDER_ARRIVED_PICKUP')).toBe('Rider at counter');
  });

  it('a status this build does not know is "Status unavailable", never the code', () => {
    for (const value of ['SOME_NEW_STATUS', 'toString', 'constructor', '__proto__', '', null, undefined, 7]) {
      expect(storeOrderStatusWords(value), String(value)).toBe('Status unavailable');
    }
  });
});

describe('cancellation reasons read as words, never as codes', () => {
  it.each(['customer', 'store'] as const)('the codes the server writes read as words for the %s', (reader) => {
    for (const code of ['NO_DRIVERS_AVAILABLE', 'FOOD_TOO_OLD']) {
      const words = cancellationReasonWords(code, reader);
      expect(words, code).toBeTruthy();
      expect(words, code).not.toMatch(LOOKS_LIKE_A_CODE);
    }
  });

  it('each reader gets its own words', () => {
    expect(cancellationReasonWords('FOOD_TOO_OLD', 'customer')).toBe('Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.');
    expect(cancellationReasonWords('FOOD_TOO_OLD', 'store')).toBe('Too old to deliver: the order was ready but no rider could be found in time.');
    expect(cancellationReasonWords('NO_DRIVERS_AVAILABLE', 'customer')).toBe('No drivers came online in time, so your request was released. Nothing to pay.');
    expect(cancellationReasonWords('NO_DRIVERS_AVAILABLE', 'store')).toBe('No driver was found in time.');
  });

  it('a code this build does not know reads as a neutral sentence, never the code', () => {
    for (const code of ['SOME_NEW_CODE', 'X', 'EXPIRED', 'MMG_NOT_PAID_IN_TIME', 'CODE_2', 'CONSTRUCTOR']) {
      expect(cancellationReasonWords(code, 'customer'), code).toBe('This order was cancelled.');
      expect(cancellationReasonWords(code, 'store'), code).toBe('No further details are available.');
      expect(cancellationReasonWords(`  ${code} `, 'store'), code).toBe('No further details are available.');
    }
    expect(UNKNOWN_CANCELLATION_WORDS.customer).toBe(ORDER_CANCELLED_WORDS);
  });

  it('text a person typed, and the server\'s own sentences, are kept as written', () => {
    expect(cancellationReasonWords('Kitchen is too busy', 'customer')).toBe('Kitchen is too busy');
    expect(cancellationReasonWords('  Customer changed their mind ', 'store')).toBe('Customer changed their mind');
    expect(cancellationReasonWords('constructor', 'store')).toBe('constructor');
    expect(cancellationReasonWords('Auto-cancelled: vendor did not respond', 'store')).toBe('Auto-cancelled: vendor did not respond');
  });

  it('no reason is nothing to say', () => {
    for (const value of [null, undefined, '', '   ', 42, {}]) expect(cancellationReasonWords(value, 'store')).toBeNull();
  });
});
