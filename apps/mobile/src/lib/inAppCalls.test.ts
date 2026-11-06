import { describe, expect, it } from 'vitest';
import { CALL_SCREEN_TEMPLATE, INAPP_WORDS, OUTGOING_HANDLE, inAppErrorText, offerInApp } from './inAppCalls';

// [INAPP-CALLS] When "Call in app" shows, and the words people read.
describe('[INAPP-CALLS] offerInApp', () => {
  it('only with the switch on, the calling module in this build, an order, and never for the parcel recipient', () => {
    const on = { enabled: true };
    expect(offerInApp(on, true, 'o1', 'rider')).toBe(true);
    expect(offerInApp(on, true, 'o1', 'store')).toBe(true);
    expect(offerInApp(on, true, 'o1', 'recipient')).toBe(false);
    expect(offerInApp({ enabled: false }, true, 'o1', 'rider')).toBe(false);
    expect(offerInApp(null, true, 'o1', 'rider')).toBe(false);
    expect(offerInApp(on, false, 'o1', 'rider')).toBe(false); // builds 11/12: no module
    expect(offerInApp(on, true, null, 'rider')).toBe(false);
  });
});

describe('[INAPP-CALLS] words', () => {
  it('every refusal is plain words with a way forward, and none shows a number', () => {
    for (const code of ['INAPP_CALLS_OFF', 'CALL_ORDER_NOT_LIVE', 'CALL_IN_PROGRESS', 'CALL_LIMIT_REACHED', 'INAPP_NO_ONE', 'INAPP_NOT_FOR_TARGET', 'MIC_REFUSED', 'WHATEVER', null]) {
      const text = inAppErrorText(code);
      expect(text.length, String(code)).toBeGreaterThan(20);
      expect(text).not.toMatch(/\d{3}/);
    }
    expect(inAppErrorText('INAPP_NOT_FOR_TARGET')).toContain('Call via Swift');
  });

  it('the microphone is explained before it is asked for, and says Swift never records', () => {
    expect(INAPP_WORDS.micWhy).toBe('Swift needs the microphone so you can talk on in-app calls. Swift never records calls.');
    expect(INAPP_WORDS.label).toBe('Call in app');
  });

  it('the call screen shows the server\'s role line; recent calls show "Swift"', () => {
    expect(CALL_SCREEN_TEMPLATE).toBe('${swiftLine}');
    expect(OUTGOING_HANDLE).toBe('Swift');
  });
});
