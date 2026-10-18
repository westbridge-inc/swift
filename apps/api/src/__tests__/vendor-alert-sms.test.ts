import { describe, expect, it } from 'vitest';
import { SMS_SINGLE_SEGMENT, isGsm7Basic, toGsm7, vendorAlertSmsText } from '../modules/notification/vendor-alert-sms';

// ---------------------------------------------------------------------------
// [STORE-ALERT · owner ruling 18 Oct 2026] The store's backup SMS:
//   "Swift: new order <no> at <store> is waiting. Open the Swift app to accept
//    or decline. It cancels by itself in <N> min."
// Plain GSM-7 (one non-GSM character turns the whole SMS into UCS-2: 70
// characters a segment), ONE message (<= 160), N rounded down from the real
// auto-cancel moment. Pure: no database.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-18T05:05:10.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('toGsm7: a store name never turns the SMS into UCS-2', () => {
  it.each([
    ['Mama’s “Best” Roti', 'Mama\'s "Best" Roti'],
    ['Café Ça Va', 'Café Ça Va'], // both in the GSM-7 basic set
    ['Piña & Açaí — Bar', 'Piña & Acai - Bar'], // ç and í are not: accents dropped
    ['Roti \u{1F32F} Shop \u{1F525}\u{1F525}', 'Roti Shop'],
    ['Jerk [Hut] {East} ~ Coast | Grill', 'Jerk (Hut) (East) - Coast / Grill'],
    ['  Tab\there and\nthere  ', 'Tab here and there'],
    ['Price€^Point…', 'PriceEURPoint...'],
    ['店 \u{1F600}', ''],
  ])('%j -> %j', (raw, expected) => {
    expect(toGsm7(raw)).toBe(expected);
    expect(isGsm7Basic(toGsm7(raw))).toBe(true);
  });
});

describe('vendorAlertSmsText: the owner ruled wording, one GSM-7 SMS', () => {
  it('names the order, the store and the whole minutes left (rounded down)', () => {
    expect(vendorAlertSmsText({ orderNumber: 'SW-261018-00293G', storeName: 'Ladder Kitchen', cancelAt: at(3 * 60_000 + 52_000), now: NOW }))
      .toBe('Swift: new order SW-261018-00293G at Ladder Kitchen is waiting. Open the Swift app to accept or decline. It cancels by itself in 3 min.');
  });

  it('never claims a minute it does not have: under a minute says so', () => {
    expect(vendorAlertSmsText({ orderNumber: 'SW-1', storeName: 'A', cancelAt: at(59_999), now: NOW }))
      .toBe('Swift: new order SW-1 at A is waiting. Open the Swift app to accept or decline. It cancels by itself in under 1 min.');
    expect(vendorAlertSmsText({ orderNumber: 'SW-1', storeName: 'A', cancelAt: at(-5_000), now: NOW }))
      .toContain('It cancels by itself in under 1 min.');
  });

  it('a booking clock of hours reads in hours, rounded down', () => {
    expect(vendorAlertSmsText({ orderNumber: 'SW-2', storeName: 'Cuts', cancelAt: at(5 * 3_600_000 + 59 * 60_000), now: NOW }))
      .toContain('It cancels by itself in 5 h.');
    expect(vendorAlertSmsText({ orderNumber: 'SW-2', storeName: 'Cuts', cancelAt: at(119 * 60_000 + 30_000), now: NOW }))
      .toContain('It cancels by itself in 119 min.');
  });

  it('a long store name is trimmed so the whole SMS is ONE segment; the deadline is never cut', () => {
    const name = 'The Very Long Name Of A Georgetown Family Restaurant And Bakery On Regent Street';
    const text = vendorAlertSmsText({ orderNumber: 'SW-261018-00293G', storeName: name, cancelAt: at(9 * 60_000 + 1), now: NOW });
    expect(text.length).toBeLessThanOrEqual(SMS_SINGLE_SEGMENT);
    expect(text.startsWith('Swift: new order SW-261018-00293G at The Very Long Name')).toBe(true);
    expect(text.endsWith(' is waiting. Open the Swift app to accept or decline. It cancels by itself in 9 min.')).toBe(true);
    expect(isGsm7Basic(text)).toBe(true);
  });

  it('a name with nothing GSM-7 left still reads: "your store"', () => {
    expect(vendorAlertSmsText({ orderNumber: 'SW-3', storeName: '\u{1F355}\u{1F355}', cancelAt: at(4 * 60_000), now: NOW }))
      .toBe('Swift: new order SW-3 at your store is waiting. Open the Swift app to accept or decline. It cancels by itself in 4 min.');
  });

  it('with no known auto-cancel moment the sentence is left out rather than guessed', () => {
    expect(vendorAlertSmsText({ orderNumber: 'SW-4', storeName: 'Ladder Kitchen', cancelAt: null, now: NOW }))
      .toBe('Swift: new order SW-4 at Ladder Kitchen is waiting. Open the Swift app to accept or decline.');
  });
});
