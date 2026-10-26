import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALL_BRIDGE_HEADER, CALL_WORDS, RECIPIENT_CALL_WORDS, bridgeErrorText, callChoice, saveNumberTip } from './callBridge';

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
  it('the save-number tip shows Swift\'s number only when there is one', () => {
    expect(saveNumberTip('+15005550006')).toBe('Swift calls come from +15005550006. Save it in your contacts as “Swift” so you know it’s us.');
    expect(saveNumberTip(null)).toBeNull();
  });
  it('every refusal the server can give has its own words; anything else a safe general line', () => {
    for (const code of ['CALL_RELAY_OFF', 'CALL_ORDER_NOT_LIVE', 'CALL_IN_PROGRESS', 'CALL_LIMIT_REACHED', 'CALL_NO_NUMBER']) {
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

  it('the courier rider\'s recipient control is Swift-only: it is handed no number, and the app never reads the recipient\'s', () => {
    const screen = src('modules/mover/screens/ActiveJobScreen.tsx');
    expect(screen).toMatch(/<CallParty orderId=\{job\?\.id\} target="recipient" phone=\{null\}/);
    // no build has ever shown or dialled the number the sender typed; with the bridge off this keeps it so
    expect(screen).not.toMatch(/courierRecipientPhone/);
  });
});
