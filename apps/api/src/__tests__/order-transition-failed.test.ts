import { describe, it, expect } from 'vitest';
import { ORDER_TRANSITIONS } from '../modules/order/order.service';
import { HANDOVER_STATES } from '../modules/cash/cash-rules.service';

// SWIFT-096: a failed cash handover is the ONLY path an order takes into FAILED
// (cash-rules.recordHandover → updateStatus(orderId, 'FAILED')), and that method
// throws NOT_AT_DOOR unless the order is in HANDOVER_STATES. So the state
// machine's FAILED predecessor list must EQUAL HANDOVER_STATES — anything wider
// is a transition no code can produce, and a lie about what "failed" means.
// This test binds the two sources so they can never silently drift (rule #17).

describe('ORDER_TRANSITIONS.FAILED matches the handover guard (SWIFT-096)', () => {
  it('FAILED is reachable only from the exact states a handover can be recorded from', () => {
    expect([...ORDER_TRANSITIONS.FAILED].sort()).toEqual([...HANDOVER_STATES].sort());
  });

  it('the real at-the-door path (ARRIVED → FAILED) is preserved', () => {
    expect(ORDER_TRANSITIONS.FAILED).toContain('ARRIVED');
  });

  it('an unstarted or in-transit order can no longer jump straight to FAILED', () => {
    // These are the states the old table permitted but the NOT_AT_DOOR guard
    // always rejected — such an order is CANCELLED, never FAILED.
    for (const impossible of ['PENDING', 'PICKED_UP', 'EN_ROUTE_DELIVERY'] as const) {
      expect(ORDER_TRANSITIONS.FAILED).not.toContain(impossible);
    }
  });
});
