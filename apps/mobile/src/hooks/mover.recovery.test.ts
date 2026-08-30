import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [G5 · P12] The client half of offer recovery.
//
// The server proof (dispatch-offer-recovery.test.ts) shows the rebuilt card
// carries every fact the live card carried. This pins the app's half of law
// 5: it ASKS — on mount and on every socket reconnect — and it renders the
// recovered card through the same fields as a live one, so "same card" is not
// a second code path that can drift.
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOOK = strip(readFileSync(new URL('./mover.ts', import.meta.url), 'utf8'));
const CARD = strip(readFileSync(new URL('../modules/mover/screens/MoverHomeScreen.tsx', import.meta.url), 'utf8'));

describe('the app asks the server for its live offer', () => {
  const body = HOOK.slice(HOOK.indexOf('export function useDispatchOffers('), HOOK.indexOf('return {\n    offer,'));

  it('on mount, and again on every reconnect', () => {
    expect(body).toContain('api.currentOffer()');
    expect(body).toMatch(/void recover\(\);/);
    expect(body).toContain("s.on('connect', recover);");
    expect(body).toContain("s.off('connect', recover);");
  });

  it('the recovered card enters the SAME queue as a live one, generation and all', () => {
    // No parallel "recovered" state: it is pushed as a DispatchOffer, with the
    // attempt id the accept will echo.
    expect(body).toContain('offerAttemptId: data.offer.offerAttemptId ?? undefined');
    expect(body).toContain('setOffer(recoveredOffer);');
    expect(body).toContain('markSeen(recoveredOffer.orderId, recoveredOffer.offerAttemptId);');
  });
});

describe('the card renders live and recovered offers through one path', () => {
  it('reads the ETA and the cash box from the offer object — never from a side channel', () => {
    expect(CARD).toContain('offer.etaMinutes != null');
    expect(CARD).toContain('offer.cashMath ?');
    // A cash box is rendered or absent; nothing on the client computes money.
    expect(CARD).not.toMatch(/collectFromCustomer\s*[-+*/]/);
    expect(CARD).not.toMatch(/payToVendor\s*[-+*/]/);
  });
});
