import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKING_REJECT_REASONS, ORDER_REJECT_REASONS, rejectReasonsFor } from '../rejectReasons';

// ---------------------------------------------------------------------------
// [E10 · DS200 D1] EVERY REJECTION CARRIES ITS REASON.
//
// The API now refuses a rejection without a reason (400 VALIDATION_ERROR): the
// customer is told why, and "Rejected by vendor" told them nothing. The order
// screen and the takeover already collected a preset. The order BOARD did not:
// its Reject/Decline button sent a bare { } — under the new rule every tap from
// the board would fail, and the board renders no error. The harness has no
// React Native renderer, so the board is pinned as a source contract (the same
// shape as pickup-handover.test.ts).
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const board = read('src/modules/vendor/screens/VendorOps.tsx');
const detail = read('src/modules/vendor/screens/VendorOrderDetailScreen.tsx');
const takeover = read('src/modules/vendor/NewOrderTakeover.tsx');
const hook = read('src/hooks/vendorops.ts');
const api = read('src/services/api.ts');

describe('[E10] the board collects a reason before it rejects', () => {
  it('every board card routes Reject/Decline to the reason chooser, never straight to the API', () => {
    const handlers = board.match(/onAction=\{[\s\S]*?\}\}?\n/g) ?? [];
    expect(handlers.length).toBe(3);
    for (const h of handlers) expect(h).toMatch(/action === 'reject'[\s\S]*setRejecting\(/);
    // the old shape: every action, reject included, mutated with no reason
    expect(board).not.toMatch(/onAction=\{\(action, code\) => orderAction\.mutate\(\{ id: o\.id, action, code \}\)\}/);
  });

  it('the chooser sends the chosen preset as the reason', () => {
    expect(board).toMatch(/rejectReasonsFor\(rejecting\?\.fulfillment\)\.map/);
    expect(board).toMatch(/orderAction\.mutate\(\{ id: target\.id, action: 'reject', reason: why \}\)/);
  });

  it('the order screen asks the question that fits the order (DS221 S3)', () => {
    expect(detail).toContain("{order.fulfillment === 'APPOINTMENT' ? 'Decline this booking?' : 'Reject this order?'}");
  });

  it('the order screen and the takeover use the same reasons for the same kind of order', () => {
    expect(detail).toMatch(/rejectReasonsFor\(order\.fulfillment\)\.map/);
    expect(takeover).toMatch(/rejectReasonsFor\(o\?\.fulfillment\)\.map/);
    for (const src of [board, detail, takeover]) expect(src).not.toMatch(/\['Out of stock', 'Kitchen is too busy', 'Closing soon'\] as const\)\.map/);
  });

  it('the client can no longer send a bare rejection, and the hook refuses one', () => {
    expect(api).toMatch(/reject: \(id: string, reason: string\) => api\.put\(`\/vendor\/orders\/\$\{id\}\/reject`, \{ reason \}\)/);
    expect(api).not.toMatch(/reason \? \{ reason \} : \{\}/);
    expect(hook).toMatch(/if \(!reason\?\.trim\(\)\) throw new Error/);
  });
});

describe('[E10 · DS200 D3] the reasons fit the order', () => {
  it('a booking is declined with booking reasons, never a kitchen one', () => {
    expect(rejectReasonsFor('APPOINTMENT')).toEqual(BOOKING_REJECT_REASONS);
    expect(rejectReasonsFor('APPOINTMENT').join(' ')).not.toMatch(/kitchen|stock/i);
  });

  it('delivery and pickup orders keep the three order presets', () => {
    for (const f of ['DELIVERY', 'PICKUP', undefined, null]) expect(rejectReasonsFor(f)).toEqual(ORDER_REJECT_REASONS);
  });
});
