import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeErrorText, callChoice, saveNumberTip, telHref } from './call-bridge';
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
    expect(saveNumberTip(null)).toBeNull();
    expect(saveNumberTip('+15005550006')).toMatch(/^Swift calls come from \+15005550006\./);
    expect(bridgeErrorText('CALL_LIMIT_REACHED')).toMatch(/as many calls/);
    expect(bridgeErrorText(undefined)).toMatch(/could not place the call/);
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
  });
});
