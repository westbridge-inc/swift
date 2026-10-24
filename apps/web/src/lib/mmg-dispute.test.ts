import { describe, expect, it } from 'vitest';
import { MMG_DISPUTE_NOTICE, mmgDisputePaused } from './mmg-dispute';
import * as app from '../../../mobile/src/modules/vendor/order-dispute';

// The web's dispute pause (board, order window, takeover, Orders home) and the
// app's (order-dispute.ts, which the Orders home card actions also read through
// lib/vendor-hub) must never drift apart: same words, same rule.
describe('[Item 10] the web and the app pause the same disputed MMG orders, in the same words', () => {
  it('says the app’s words', () => {
    expect(MMG_DISPUTE_NOTICE).toEqual(app.MMG_DISPUTE_NOTICE);
  });

  it('pauses exactly the orders the app pauses', () => {
    const at = '2026-10-16T12:00:00.000Z';
    const cases: Array<Record<string, unknown> | null | undefined> = [null, undefined];
    for (const paymentMethod of ['MOBILE_MONEY', 'CASH', undefined]) {
      for (const orderType of ['DELIVERY', 'TAXI', undefined]) {
        for (const status of ['PENDING', 'preparing', 'READY_FOR_PICKUP', 'DELIVERED', 'completed', 'CANCELLED', 'REFUNDED', 'FAILED', undefined]) {
          for (const mmgClaimMismatchAt of [at, null, undefined, '', false]) cases.push({ paymentMethod, orderType, status, mmgClaimMismatchAt });
        }
      }
    }
    const paused = cases.filter((order) => mmgDisputePaused(order as never)).length;
    expect(paused).toBeGreaterThan(0);
    for (const order of cases) expect(mmgDisputePaused(order as never), JSON.stringify(order)).toBe(app.mmgDisputePaused(order as never));
  });
});
