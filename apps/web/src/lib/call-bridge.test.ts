import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALLER_LINE_WORDS, bridgeErrorText, callChoice, callerLine, swiftContactCard, telHref } from './call-bridge';
import { CALL_BRIDGE_HEADER } from './call-bridge-header';

// [O-1 · owner 24 Oct 06:00Z] Bridge OFF (launch): today's tel: link. Bridge ON: "Call via Swift".
const ON = { enabled: true, callerId: '+15005550006' };
const OFF = { enabled: false, callerId: null };
const PHONE = '+592 060-0001';

describe('[O-1] what the Call control does on the website', () => {
  it('bridge off or unreadable: the tel: link on the number the API sent, as today', () => {
    expect(callChoice(OFF, PHONE, 'o1')).toEqual({ mode: 'dial', href: 'tel:+5920600001' });
    expect(callChoice(null, PHONE, 'o1')).toEqual({ mode: 'dial', href: 'tel:+5920600001' });
  });
  it('bridge on: Swift connects it; no order or no number: no button', () => {
    expect(callChoice(ON, null, 'o1')).toEqual({ mode: 'bridge' });
    expect(callChoice(ON, null, null)).toEqual({ mode: 'none' });
    expect(callChoice(OFF, null, 'o1')).toEqual({ mode: 'none' });
    expect(telHref('not a phone')).toBeNull();
  });
  it('the words', () => {
    expect(callerLine(null)).toBeNull();
    expect(callerLine('+15005550006')).toBe('Swift calls you from +1 500 555 0006 (save it as Swift).');
    expect(callerLine('+5926001234')).toBe('Swift calls you from +592 600 1234 (save it as Swift).');
    expect(bridgeErrorText('CALL_DAILY_LIMIT_REACHED')).toBe('Swift calls are busy right now. Message them in chat, or ask support.');
    expect(bridgeErrorText('CALL_CALLER_NUMBER_UNSUPPORTED')).toBe('Swift calls only Guyana numbers, not yours. Message them in chat, or ask support.');
    expect(bridgeErrorText('CALL_CALLER_BUSY')).toBe('You already have a Swift call ringing. Answer it, or try again in a minute.');
    expect(bridgeErrorText('CALL_USER_DAILY_LIMIT_REACHED')).toBe('You have used your Swift calls for today. Message them in chat, or ask support.');
    expect(bridgeErrorText('CALL_LIMIT_REACHED')).toMatch(/as many calls/);
    expect(bridgeErrorText(undefined)).toMatch(/could not place the call/);
  });
});

// [CALL-RELAY-ON · owner 6 Nov 2026] "So a call does not look like a scam": the number Swift calls from, to save.
describe('[CALL-RELAY-ON] the caller line and the contact card', () => {
  it('words are GSM-7 safe and short (they read the same in a text message)', () => {
    const GSM7_PLAIN = /^[A-Za-z0-9 +().,:;'!?-]*$/;
    for (const words of [callerLine('+18785550123')!, ...Object.values(CALLER_LINE_WORDS), bridgeErrorText('CALL_DAILY_LIMIT_REACHED'), bridgeErrorText('CALL_USER_DAILY_LIMIT_REACHED'), bridgeErrorText('CALL_CALLER_BUSY'), bridgeErrorText('CALL_CALLER_NUMBER_UNSUPPORTED')]) {
      expect(words, words).toMatch(GSM7_PLAIN);
      expect(words.length, words).toBeLessThanOrEqual(90);
    }
  });
  it('the contact card names Swift and carries only Swift\'s number, from the server', () => {
    const card = swiftContactCard('+18785550123');
    expect(card).toBe('BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Swift;;;\r\nFN:Swift\r\nORG:Swift\r\nTEL;TYPE=VOICE:+18785550123\r\nEND:VCARD\r\n');
    expect(swiftContactCard('not a number')).toBeNull();
    expect(swiftContactCard(null)).toBeNull();
  });
});

describe('[O-1] wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  it('every API request from the website says it knows the bridge', () => {
    expect(CALL_BRIDGE_HEADER).toBe('x-swift-call-bridge');
    expect(src('lib/auth.ts')).toMatch(/\[CALL_BRIDGE_HEADER\]: CALL_BRIDGE_VERSION,/);
  });
  it('the customer order page and the store dashboard call through CallPartyButton, never a tel: on a counterpart number', () => {
    const page = src('app/(app)/orders/[id]/page.tsx');
    expect(page).toContain('<CallPartyButton');
    expect(page).not.toMatch(/tel:\$\{order\.rider\.phone\}/);
    const desk = src('app/dashboard/orders/order-detail.tsx');
    expect(desk).toContain('target="customer"');
    expect(desk).toContain('target="rider"');
    expect(desk).not.toMatch(/href=\{(customer|rider)Tel\}/);
    // [CALL-RELAY-ON] The desk shows the caller line once (under the customer's Call), not twice.
    expect(desk).toMatch(/target="rider"[^>]*callerLine=\{false\}/);
    expect(desk).not.toMatch(/target="customer"[^>]*callerLine=\{false\}/);
  });
});
