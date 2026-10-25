import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALL_BRIDGE_HEADER, CALL_WORDS, bridgeErrorText, callChoice, saveNumberTip } from './callBridge';

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
});
