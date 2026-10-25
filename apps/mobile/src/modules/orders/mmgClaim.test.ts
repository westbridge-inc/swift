import { describe, expect, it } from 'vitest';
import { boundMmgClaim, mmgClaimPresentation, parseMmgClaimView, sendBoundMmgClaim, type MmgClaimView, type PendingMmgClaim } from './mmgClaim';

// ---------------------------------------------------------------------------
// [ORDER-SPINE S1-6] The customer's own words about a direct-MMG payment.
//
// Swift holds none of this money: the customer pays the store's wallet and the
// store says whether it arrived. The server already recorded a customer's "I
// did not pay" — but no first-party screen could ever send it, so a customer
// who was falsely reported as paid had no way to stop the order. These pin the
// presentation the order screen renders from the server's projection.
// ---------------------------------------------------------------------------

const base: MmgClaimView = {
  customerClaim: 'UNRECORDED', customerClaimAt: null, storeClaimed: false, providerCaptured: false,
  disputed: false, disputedAt: null, resolution: null, resolvedAt: null, attemptRejected: false,
  revision: 0, canClaim: true,
};
const view = (over: Partial<MmgClaimView>): MmgClaimView => ({ ...base, ...over });

describe('parseMmgClaimView — the server projection, strictly', () => {
  it('accepts the exact server shape', () => {
    const raw = { ...base, customerClaim: 'NOT_PAID', customerClaimAt: '2026-09-22T10:00:00.000Z', storeClaimed: true, disputed: true, disputedAt: '2026-09-22T10:01:00.000Z', revision: 2 };
    expect(parseMmgClaimView(raw)).toEqual(raw);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not an object', 'NOT_PAID'],
    ['unknown claim', { ...base, customerClaim: 'MAYBE' }],
    ['unknown resolution', { ...base, resolution: 'SPLIT' }],
    ['negative revision', { ...base, revision: -1 }],
    ['fractional revision', { ...base, revision: 1.5 }],
    ['truthy string flag', { ...base, canClaim: 'yes' }],
    ['missing flag', (({ disputed: _d, ...rest }) => rest)(base)],
    ['non-string timestamp', { ...base, customerClaimAt: 12 }],
  ])('fails closed — %s renders nothing', (_label, raw) => {
    expect(parseMmgClaimView(raw)).toBeNull();
  });
});

describe('what the customer is shown, and what they can say', () => {
  const labels = (v: MmgClaimView) => mmgClaimPresentation(v).actions.map((a) => a.label);

  it('before anyone has said anything: both statements are offered; "I didn\'t pay" asks first', () => {
    const p = mmgClaimPresentation(base);
    expect(p.tone).toBe('neutral');
    expect(labels(base)).toEqual(['I paid the store', 'I didn’t pay']);
    expect(p.actions.find((a) => !a.paid)?.confirm).not.toBeNull();
    expect(p.actions.find((a) => a.paid)?.confirm).toBeNull();
  });

  it('the store\'s report is presented as the store\'s word, with the way to dispute it', () => {
    const p = mmgClaimPresentation(view({ storeClaimed: true, revision: 1 }));
    expect(p.title).toMatch(/store reported/i);
    expect(p.body).toMatch(/doesn’t hold or check/);
    expect(p.body).not.toMatch(/confirmed/i);
    const deny = p.actions.find((a) => !a.paid)!;
    expect(deny.label).toBe('I didn’t pay');
    expect(deny.confirm?.body).toMatch(/pauses the order/);
  });

  it('a customer who already said "I paid" can still correct it, and vice versa', () => {
    expect(labels(view({ customerClaim: 'PAID', customerClaimAt: 'x' }))).toEqual(['I didn’t pay']);
    expect(labels(view({ customerClaim: 'NOT_PAID', customerClaimAt: 'x' }))).toEqual(['I paid the store']);
  });

  it('an open disagreement says the order is paused for a person — never that it is settled', () => {
    const p = mmgClaimPresentation(view({ storeClaimed: true, customerClaim: 'NOT_PAID', customerClaimAt: 'x', disputed: true, disputedAt: 'y', revision: 2 }));
    expect(p.tone).toBe('warning');
    expect(p.title).toBe('Payment under review');
    expect(p.body).toMatch(/paused/);
    expect(p.body).toMatch(/never holds/);
  });

  it('a rejected store report offers nothing to press — the only way forward is to cancel', () => {
    const p = mmgClaimPresentation(view({ attemptRejected: true, resolution: 'CUSTOMER_DID_NOT_PAY', resolvedAt: 'z', revision: 3 }));
    expect(p.tone).toBe('warning');
    expect(p.actions).toEqual([]);
    expect(p.body).toMatch(/cancel/);
  });

  it('an upheld report reads as finished', () => {
    const p = mmgClaimPresentation(view({ storeClaimed: true, customerClaim: 'NOT_PAID', customerClaimAt: 'x', resolution: 'CUSTOMER_PAID', resolvedAt: 'z', revision: 3 }));
    expect(p.tone).toBe('success');
    expect(p.title).toBe('Payment review finished');
  });

  it('when the server says no claim can be made, no control is rendered', () => {
    expect(mmgClaimPresentation(view({ canClaim: false })).actions).toEqual([]);
    expect(mmgClaimPresentation(view({ canClaim: false, storeClaimed: true })).actions).toEqual([]);
  });

  it('no state promises that Swift holds, verifies or refunds the money', () => {
    const states: MmgClaimView[] = [
      base, view({ storeClaimed: true }), view({ providerCaptured: true }), view({ customerClaim: 'PAID', customerClaimAt: 'x' }),
      view({ customerClaim: 'NOT_PAID', customerClaimAt: 'x' }), view({ disputed: true, disputedAt: 'y', storeClaimed: true }),
      view({ attemptRejected: true, resolution: 'CUSTOMER_DID_NOT_PAY', resolvedAt: 'z' }), view({ resolution: 'CUSTOMER_PAID', resolvedAt: 'z', storeClaimed: true }),
    ];
    for (const s of states) {
      const p = mmgClaimPresentation(s);
      const text = [p.title, p.body, ...p.actions.flatMap((a) => [a.label, a.confirm?.title ?? '', a.confirm?.body ?? ''])].join(' ');
      expect(text).not.toMatch(/Swift (holds|verified|confirms|will refund|refunds)/i);
    }
  });
});

describe('a confirmation is bound to the order it was opened on [R4 · F-PR1262-SOL-01]', () => {
  const deny = mmgClaimPresentation(base).actions.find((a) => !a.paid)!;
  const pending: PendingMmgClaim = { orderId: 'order-A', action: deny };

  it('is shown only while the screen shows that order', () => {
    expect(boundMmgClaim(pending, 'order-A')).toBe(pending);
    expect(boundMmgClaim(pending, 'order-B')).toBeNull();
    expect(boundMmgClaim(pending, '')).toBeNull();
    expect(boundMmgClaim(pending, undefined)).toBeNull();
    expect(boundMmgClaim(null, 'order-A')).toBeNull();
  });

  it('is sent to its own order with its own choice — and not at all once the screen shows another order', () => {
    const sent: Array<{ orderId: string; paid: boolean }> = [];
    expect(sendBoundMmgClaim(pending, 'order-B', (claim) => sent.push(claim))).toBe(false);
    expect(sent).toEqual([]);
    expect(sendBoundMmgClaim(pending, 'order-A', (claim) => sent.push(claim))).toBe(true);
    expect(sent).toEqual([{ orderId: 'order-A', paid: false }]);
  });
});
