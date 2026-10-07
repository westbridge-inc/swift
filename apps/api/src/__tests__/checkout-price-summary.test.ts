import { describe, expect, it } from 'vitest';
import { assertPricesAsSeen } from '../modules/order/order.service';
import { AppError } from '../utils/errors';

// [L09 · price lock] A PRICE_CHANGED refusal stays small however large the
// cart is: the message names five lines, the details carry fifty, and the full
// count travels beside them. (Duplicate line IDs never get this far: the route
// and the service refuse them before checkout takes a lock.)
function refusal(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const cartOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `line-${i}`, unitPrice: 1, item: { name: `Item ${i}` } }));

describe('[L09 · price lock] the PRICE_CHANGED refusal is bounded', () => {
  it('a 250-line cart that all changed: five lines named, fifty in details, the full count kept', () => {
    const lines = cartOf(250);
    const error = refusal(() => assertPricesAsSeen({ lines: lines.map((l) => ({ lineId: l.id, unitPrice: 0 })), total: 0 }, lines, 250));
    const details = error.details as { lines: unknown[]; changedLineCount: number; total: unknown };
    expect(error.code).toBe('PRICE_CHANGED');
    expect(details.lines).toHaveLength(50);
    expect(details.changedLineCount).toBe(250);
    expect(details.total).toEqual({ seen: 0, now: 250 });
    expect(error.message).toBe(
      'Prices changed since you last looked: Item 0 GYD 0 → GYD 1; Item 1 GYD 0 → GYD 1; Item 2 GYD 0 → GYD 1; '
      + 'Item 3 GYD 0 → GYD 1; Item 4 GYD 0 → GYD 1; and 245 other lines; total GYD 0 → GYD 250. '
      + 'Review your cart and place the order again.',
    );
  });

  it('six changed lines: five named, then "and 1 other line" (singular)', () => {
    const lines = cartOf(6);
    const error = refusal(() => assertPricesAsSeen({ lines: lines.map((l) => ({ lineId: l.id, unitPrice: 0 })) }, lines, 6));
    expect(error.message).toContain('Item 4 GYD 0 → GYD 1; and 1 other line. Review your cart');
  });

  it('a small change still names every changed line, and nothing is refused when the prices match', () => {
    const lines = cartOf(3);
    const error = refusal(() => assertPricesAsSeen({ lines: [{ lineId: 'line-1', unitPrice: 0.5 }] }, lines, 3));
    expect(error.message).toBe('Prices changed since you last looked: Item 1 GYD 0.5 → GYD 1. Review your cart and place the order again.');
    expect(error.details).toEqual({ lines: [{ lineId: 'line-1', name: 'Item 1', seen: 0.5, now: 1 }], changedLineCount: 1, total: null });
    expect(() => assertPricesAsSeen({ lines: lines.map((l) => ({ lineId: l.id, unitPrice: 1 })), total: 3 }, lines, 3)).not.toThrow();
  });
});
