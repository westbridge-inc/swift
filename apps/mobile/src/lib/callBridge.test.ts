import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALLER_LINE_WORDS, CALL_BRIDGE_HEADER, CALL_WORDS, RECIPIENT_CALL_WORDS, bridgeErrorText, callChoice, callerLine, formatCallerId } from './callBridge';

// ---------------------------------------------------------------------------
// [O-1 · owner 24 Oct 06:00Z] Bridge OFF (the launch state): exactly today's
// Call button (the dialler, on the number the server sent). Bridge ON: "Call
// via Swift"; the server sends no number then. Neither: no Call button.
// ---------------------------------------------------------------------------

const ON = { enabled: true, callerId: '+15005550006' };
const OFF = { enabled: false, callerId: null };
const PHONE = '+5920600001';

describe('[O-1] what the Call control does', () => {
  it('bridge off (or its config unreadable): dial the number the server sent, as today', () => {
    expect(callChoice(OFF, PHONE, 'o1')).toEqual({ mode: 'dial', phone: PHONE });
    expect(callChoice(null, PHONE, 'o1')).toEqual({ mode: 'dial', phone: PHONE });
    expect(callChoice(undefined, PHONE, 'o1')).toEqual({ mode: 'dial', phone: PHONE });
  });
  it('bridge on: Swift connects the call, whatever number is (not) on the phone', () => {
    expect(callChoice(ON, null, 'o1')).toEqual({ mode: 'bridge' });
    expect(callChoice(ON, PHONE, 'o1')).toEqual({ mode: 'bridge' });
  });
  it('without an order Swift cannot connect; with no number either, there is no Call button', () => {
    expect(callChoice(ON, PHONE, null)).toEqual({ mode: 'dial', phone: PHONE });
    expect(callChoice(ON, null, null)).toEqual({ mode: 'none' });
    expect(callChoice(OFF, null, 'o1')).toEqual({ mode: 'none' });
  });
});

describe('[O-1] the words', () => {
  // [CALL-RELAY-ON · owner 6 Nov] "So a call does not look like a scam": Guyana networks show only the number, so the
  // screen says which number Swift calls from, in words that also fit a plain text message (GSM-7, no curly quotes).
  it('the caller line names Swift\'s number from the server, spaced to read, and asks to save it as Swift', () => {
    expect(callerLine('+15005550006')).toBe('Swift calls you from +1 500 555 0006 (save it as Swift).');
    expect(callerLine('+5926001234')).toBe('Swift calls you from +592 600 1234 (save it as Swift).');
    expect(callerLine('+447700900123')).toBe('Swift calls you from +447700900123 (save it as Swift).');
    expect(callerLine(null)).toBeNull();
    expect(callerLine('')).toBeNull();
    expect(formatCallerId('+18785550123')).toBe('+1 878 555 0123');
  });
  it('every caller-line word is GSM-7 safe and short', () => {
    const GSM7_PLAIN = /^[A-Za-z0-9 +().,:;'!?-]*$/;
    for (const words of [callerLine('+18785550123')!, ...Object.values(CALLER_LINE_WORDS), CALL_WORDS.startedHow, bridgeErrorText('CALL_DAILY_LIMIT_REACHED')]) {
      expect(words, words).toMatch(GSM7_PLAIN);
      expect(words.length, words).toBeLessThanOrEqual(90);
    }
  });
  it('every refusal the server can give has its own words; anything else a safe general line', () => {
    for (const code of ['CALL_RELAY_OFF', 'CALL_ORDER_NOT_LIVE', 'CALL_IN_PROGRESS', 'CALL_LIMIT_REACHED', 'CALL_NO_NUMBER', 'CALL_DAILY_LIMIT_REACHED']) {
      expect(bridgeErrorText(code), code).not.toBe(bridgeErrorText(undefined));
      expect(bridgeErrorText(code), code).toMatch(/chat|Answer it|try again/i);
    }
    expect(bridgeErrorText('SOMETHING_NEW')).toMatch(/could not place the call/);
    expect(CALL_WORDS.startedHow).toMatch(/press 1/);
  });
  it('after a tap, it says only what is true for every app: both phones show Swift\'s number (REVIEW-F #2092 S4-1)', () => {
    // While older apps still get counterpart numbers (COUNTERPART_PHONES_TO_OLD_APPS), "neither of you sees the
    // other's number" can be false; what both phones show on this call is Swift's number.
    expect(CALL_WORDS.startedHow).toContain("Both phones show Swift's number.");
    expect(CALL_WORDS.startedHow).not.toMatch(/neither/i);
  });
});

describe('[O-1] the parcel recipient (the courier rider calls them through Swift)', () => {
  it('they did not place the order: their card says so in role words, and Swift rings them about their delivery', () => {
    expect(RECIPIENT_CALL_WORDS.title).toBe('Parcel recipient');
    expect(RECIPIENT_CALL_WORDS.subtitle).toBe('Swift rings them about their delivery');
    expect(RECIPIENT_CALL_WORDS.a11y).toBe('Call the parcel recipient via Swift');
    expect(Object.values(RECIPIENT_CALL_WORDS).join(' ')).not.toMatch(/your order|customer/i);
  });
  it('a refusal never offers a chat with the recipient (they have no account): the sender\'s chat, or support', () => {
    for (const code of ['CALL_RELAY_OFF', 'CALL_ORDER_NOT_LIVE', 'CALL_IN_PROGRESS', 'CALL_LIMIT_REACHED', 'CALL_NO_NUMBER', 'SOMETHING_NEW', undefined]) {
      const words = bridgeErrorText(code, 'recipient');
      expect(words, String(code)).not.toMatch(/message them in chat/i);
      expect(words, String(code)).toMatch(/sender|support|Answer it|try again/i);
    }
    expect(bridgeErrorText('CALL_NO_NUMBER', 'recipient')).toMatch(/no number for the recipient/);
    // everyone else keeps their words
    expect(bridgeErrorText('CALL_LIMIT_REACHED', 'rider')).toBe(bridgeErrorText('CALL_LIMIT_REACHED'));
  });
});

describe('[O-1] wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('every request says this app knows the bridge (the header name is the server\'s)', () => {
    expect(CALL_BRIDGE_HEADER).toBe('x-swift-call-bridge');
    const api = src('services/api.ts');
    expect(api).toMatch(/api\.interceptors\.request\.use\(\(config\) => \{[\s\S]*?config\.headers\[CALL_BRIDGE_HEADER\] = CALL_BRIDGE_VERSION;/);
  });

  it('every counterpart Call button goes through CallParty; none dials a counterpart number directly', () => {
    const sites: Array<[string, string]> = [
      ['modules/mover/screens/ActiveJobScreen.tsx', 'target="customer"'],
      ['modules/movement/screens/TaxiScreen.tsx', 'target="driver"'],
      ['modules/orders/screens/DeliveryScreen.tsx', 'target="rider"'],
      ['modules/vendor/screens/VendorOrderDetailScreen.tsx', 'target="rider"'],
      ['modules/vendor/screens/VendorOrderDetailScreen.tsx', 'target="customer"'],
    ];
    for (const [file, target] of sites) {
      const text = src(file);
      expect(text, file).toContain('<CallParty');
      expect(text, `${file} ${target}`).toContain(target);
      expect(text, file).not.toMatch(/tel:\$\{(cust|rider|driver\.user|phone)\b/);
    }
  });

  it('[CALL-RELAY-ON] every screen with "Call via Swift" also shows the caller line (Swift\'s number + Copy)', () => {
    for (const file of [
      'modules/mover/screens/ActiveJobScreen.tsx',
      'modules/movement/screens/TaxiScreen.tsx',
      'modules/orders/screens/DeliveryScreen.tsx',
      'modules/vendor/screens/VendorOrderDetailScreen.tsx',
    ]) {
      expect(src(file), file).toMatch(/<SwiftCallNumberTip \/>/);
    }
    // The number comes from the server's /calls/config, never typed into the app.
    const tip = src('components/SwiftCallNumberTip.tsx');
    expect(tip).toContain('useCallConfig()');
    expect(tip).not.toMatch(/\+1\s?878|\+1878/);
  });

  it('the courier rider\'s recipient control is Swift-only: it is handed no number, and the app never reads the recipient\'s', () => {
    const screen = src('modules/mover/screens/ActiveJobScreen.tsx');
    expect(screen).toMatch(/<CallParty orderId=\{job\?\.id\} target="recipient" phone=\{null\}/);
    // no build has ever shown or dialled the number the sender typed; with the bridge off this keeps it so
    expect(screen).not.toMatch(/courierRecipientPhone/);
  });
});
