import { describe, expect, it } from 'vitest';
import { feePausePredicate } from '../modules/billing/mmg-pause';
import { feeOperable, vendorActivationNext, type VendorActivationFacts } from '../modules/admin/vendor-activation';
import { subscriptionOperability } from '../modules/subscription/operate-gate';

// [PROD-PATH × MC-AD2] The console's go-live verdict reads the vendor gate's own
// rule (vendor.routes.ts: subscriptionOperability with the fee pause). While no
// partner has a live way to pay, a lapsed grace refuses nobody at the gate, so the
// console must not call that store's fee unpaid either; once the pause is lifted
// the same store is FEE_UNPAID again. A SUSPENDED subscription stays unpaid whatever
// the pause says: the pause holds a grace clock, it never lifts a suspension.

const NOW = new Date('2026-10-14T12:00:00Z');
const LAPSED = new Date('2026-10-10T12:00:00Z');
const goLive = { checklist: { complete: true }, disclosure: { engaged: false, complete: true, missing: [] }, publishedPhone: true, foodHandlers: { required: false, attested: false } } as unknown as Parameters<typeof vendorActivationNext>[1];

function pastDueLapsed(id = 'sub-held') {
  return {
    id, status: 'PAST_DUE' as const, gracePeriodEnd: LAPSED, autoRenew: true, currentPeriodEnd: LAPSED,
    billingConfirmationPausedAt: null, billingEnforcementDueAt: LAPSED, autoSuspendEnabled: true,
  };
}

function facts(subscription: VendorActivationFacts['subscription'], feePause: VendorActivationFacts['feePause']): VendorActivationFacts {
  return { status: 'SUSPENDED', suspensionSource: 'ADMIN', ownerAccountStatus: 'ACTIVE', subscription, feePause };
}

describe('[PROD-PATH] the console go-live verdict follows the vendor gate under the fee pause', () => {
  const held = feePausePredicate(false, ['sub-held']);
  const none = feePausePredicate(false);

  it('a lapsed grace held by the fee pause is operable, exactly as at the vendor gate', () => {
    const sub = pastDueLapsed();
    expect(subscriptionOperability(sub, { missingRow: 'GRANDFATHER' }, held, NOW).operable).toBe(true);
    expect(feeOperable(sub, held, NOW)).toBe(true);
  });

  it('with the pause held the store can be reinstated; with no pause the same store is FEE_UNPAID', () => {
    const sub = pastDueLapsed();
    expect(subscriptionOperability(sub, { missingRow: 'GRANDFATHER' }, none, NOW).operable).toBe(false);
    expect(vendorActivationNext(facts(sub, none), goLive)).toBe('FEE_UNPAID');
    // vendorActivationNext reads the clock itself; the lapse is days old, so "now" is past it too.
    expect(vendorActivationNext(facts(sub, held), goLive)).toBe('CAN_REINSTATE');
  });

  it('the pause is per subscription: another store’s hold does not lift this one', () => {
    expect(vendorActivationNext(facts(pastDueLapsed('sub-other'), held), goLive)).toBe('FEE_UNPAID');
  });

  it('a SUSPENDED subscription stays FEE_UNPAID even while every fee is paused', () => {
    const suspended = { ...pastDueLapsed(), status: 'SUSPENDED' as const };
    expect(vendorActivationNext(facts(suspended, feePausePredicate(true)), goLive)).toBe('FEE_UNPAID');
  });
});
