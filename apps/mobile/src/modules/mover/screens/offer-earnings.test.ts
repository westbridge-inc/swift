import { describe, expect, it } from 'vitest';
import { offerEarnings } from './offer-earnings';

describe('offerEarnings', () => {
  it('adds a delivery tip to the fare — the defect this exists to fix', () => {
    // THE BUG: the card showed 1200 while the mover would be paid 1500, at the
    // exact moment they chose whether to accept. rider.routes computes
    // `deliveryFee + tipAmount` in four places; the card used the fee alone.
    const e = offerEarnings(1200, 300, true);
    expect(e).toEqual({ fare: 1200, tip: 300, total: 1500, showTip: true });
  });

  it('never claims a taxi tip, because the driver formula is unverified', () => {
    // Driver pay accrues in an Earning table rather than being computed from
    // the order, so whether a ride tip reaches the driver is not established.
    // Promising it on the accept screen would be worse than staying silent.
    expect(offerEarnings(2500, 400, false)).toEqual({
      fare: 2500, tip: 0, total: 2500, showTip: false,
    });
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
