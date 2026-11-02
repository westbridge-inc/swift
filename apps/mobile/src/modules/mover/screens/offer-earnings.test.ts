import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { offerEarnings, owesStore } from './offer-earnings';

describe('offerEarnings', () => {
  it('adds a delivery tip to the fare — the defect this exists to fix', () => {
    // THE BUG: the card showed 1200 while the mover would be paid 1500, at the
    // exact moment they chose whether to accept. rider.routes computes
    // `deliveryFee + tipAmount` in four places; the card used the fee alone.
    const e = offerEarnings(1200, 300, true);
    expect(e).toEqual({ fare: 1200, tip: 300, total: 1500, showTip: true, bonus: 0, showBonus: false });
  });

  it('never claims a taxi tip, because the driver formula is unverified', () => {
    // Driver pay accrues in an Earning table rather than being computed from
    // the order, so whether a ride tip reaches the driver is not established.
    // Promising it on the accept screen would be worse than staying silent.
    expect(offerEarnings(2500, 400, false)).toEqual({
      fare: 2500, tip: 0, total: 2500, showTip: false, bonus: 0, showBonus: false,
    });
  });

  it('[ALG-06] shows a rescue bonus as its own line and never folds it into "you get"', () => {
    // The fare and tip land from the job (cash in hand on a CASH job); the
    // bonus is Swift's own money settled later. "you get 2000" at the door
    // would be a lie by 500.
    const e = offerEarnings(1200, 300, true, 500);
    expect(e.bonus).toBe(500);
    expect(e.showBonus).toBe(true);
    expect(e.total).toBe(1500);
    for (const none of [0, null, undefined, 'abc', -5]) {
      const q = offerEarnings(1200, 300, true, none);
      expect(q.showBonus).toBe(false);
      expect(q.bonus).toBe(0);
    }
  });

  it('renders no tip line when there is no tip', () => {
    for (const none of [0, null, undefined, '']) {
      const e = offerEarnings(900, none, true);
      expect(e.showTip).toBe(false);
      expect(e.total).toBe(900);
    }
  });

  it('never puts NaN or a negative on a pay line', () => {
    // A garbled payload must degrade to the fare, never to "$NaN" over the
    // Accept button.
    for (const junk of ['abc', NaN, Infinity, -50, {}, []]) {
      const e = offerEarnings(1000, junk, true);
      expect(Number.isFinite(e.total)).toBe(true);
      expect(e.total).toBe(1000);
      expect(e.tip).toBe(0);
    }
    const bad = offerEarnings('nonsense', 300, true);
    expect(bad.fare).toBe(0);
    expect(bad.total).toBe(300);
  });

  it('tracks the slider: the total follows the fare the mover sets', () => {
    // The slider lowers the fare to compete; the tip is fixed at checkout and
    // must not move with it.
    expect(offerEarnings(1200, 300, true).total).toBe(1500);
    expect(offerEarnings(800, 300, true).total).toBe(1100);
    expect(offerEarnings(800, 300, true).tip).toBe(300);
  });
});

describe('[promo-film finding] the cash card names a store only when one is owed', () => {
  it('a store order hands the store its share; a taxi ride or a courier job owes no store', () => {
    expect(owesStore({ payToVendor: 4200 })).toBe(true);
    // the server's cash math for a ride and for a courier job: collect the total, pay no store
    expect(owesStore({ payToVendor: 0 })).toBe(false);
    expect(owesStore({ payToVendor: '0.00' })).toBe(false);
    expect(owesStore(null)).toBe(false);
    expect(owesStore(undefined)).toBe(false);
    expect(owesStore({ payToVendor: Number.NaN })).toBe(false);
  });

  it('the offer card draws its cash math from OfferCashMath, which gates "Pay {store} …" and keeps the collect line', () => {
    const screen = readFileSync(join(__dirname, 'MoverHomeScreen.tsx'), 'utf8');
    expect(screen).toContain('<OfferCashMath cashMath={offer.cashMath} vendorName={offer.vendorName} />');
    expect(screen).not.toContain("Pay {offer.vendorName ?? 'the store'}");
    const block = readFileSync(join(__dirname, 'OfferCashMath.tsx'), 'utf8');
    expect(block).toContain('Cash job — collect {money(cashMath.collectFromCustomer)} from the customer');
    const gate = block.indexOf('{owesStore(cashMath) ? (');
    const storeLine = block.indexOf("Pay {vendorName ?? 'the store'}");
    const otherwise = block.indexOf(') : (', gate);
    const youKeepAlone = block.indexOf('You keep {money(cashMath.youKeep)}');
    // the store line is the gate's TRUE branch and "You keep" its FALSE branch (never swapped), once each
    expect(gate).toBeGreaterThan(-1);
    expect(storeLine).toBeGreaterThan(gate);
    expect(otherwise).toBeGreaterThan(storeLine);
    expect(youKeepAlone).toBeGreaterThan(otherwise);
    expect(block.split("Pay {vendorName ?? 'the store'}").length).toBe(2);
  });
});
