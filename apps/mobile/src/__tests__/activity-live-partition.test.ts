import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * THE ACTIVITY LIST ASKS THE SERVER WHICH ORDERS ARE LIVE.
 *
 * This screen has now grown the same defect three separate times, each in a
 * different disguise, and its own comments record the first two:
 *
 *   1. A local label map keyed `READY` against an enum member named
 *      `READY_FOR_PICKUP`. The key never matched, so a live order was rendered
 *      to the customer as the literal string "READY_FOR_PICKUP".
 *
 *   2. A local list of LIVE statuses used to partition the list. Five real
 *      ones were missing, so live deliveries were filed under "completed" and
 *      lost their Track order button.
 *
 *   3. A local terminal set used to FILTER LOADED PAGES. History is
 *      `placedAt` DESC and pages at 20, so this could only ever find live
 *      orders inside the customer's twenty most recent. Measured on a real
 *      account: 19 open orders, 6 visible. Three of the hidden ones had been
 *      awaiting pickup since March.
 *
 * Every one of them is the same root cause — this screen deciding for itself
 * what "still going" means, next to a server that owns the enum and already
 * exports the answer. So the rule this file enforces is not "keep the list up
 * to date"; it is that the list must not exist here at all.
 *
 * The API half is graded separately and behaviourally in
 * `apps/api/src/__tests__/orders-live-filter.test.ts`.
 */

const SRC = join(process.cwd(), 'src');
const SCREEN = join(SRC, 'modules/orders/screens/OrdersHistoryScreen.tsx');
const HOOKS = join(SRC, 'hooks/customer.ts');

/** Comments stripped — the standing hazard-matching rule. The comments in both
 *  files necessarily name the very statuses being banned. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

describe('the activity screen does not re-derive liveness', () => {
  it('holds no terminal status list of its own', () => {
    // QUOTING IS THE DISCRIMINATOR, and the first version of this assertion got
    // it wrong. `STATUS_TONE` maps every status — terminal ones included — to a
    // pill colour, as bare object keys. That is this screen's own concern: the
    // server has no opinion about maroon, and a lookup table cannot silently
    // decide an order is over. What it must not do is COMPARE, and comparing
    // requires the status as a value: `'DELIVERED'`, in a Set, an array or an
    // `includes`. So the ban is on the quoted literal, not on the word.
    const offenders = (code(SCREEN).match(/'(DELIVERED|COMPLETED|CANCELLED|REFUNDED|FAILED)'/g) ?? []);
    expect(
      offenders,
      'TERMINAL_ORDER_STATUSES lives beside the enum and the endpoint answers `live`. ' +
        'A copy here is how this screen has broken three times.',
    ).toEqual([]);
  });

  it('takes its live orders from the dedicated query', () => {
    expect(code(SCREEN), 'the IN PROGRESS section must come from useLiveOrders').toMatch(/useLiveOrders/);
  });

  it('does not filter history back down by status', () => {
    // The reconciliation is BY ID. A `.filter(o => ...o.status...)` reintroduces
    // exactly the derivation the query removed.
    const src = code(SCREEN);
    expect(/\.filter\(\([^)]*\)\s*=>[^)]*\.status/.test(src)).toBe(false);
  });

  it('the scan can see all three shapes (guards the guard)', () => {
    // The literal strings that shipped. Without these the assertions above
    // would pass against a file that had quietly regressed.
    expect(
      "const TERMINAL = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED']);".match(
        /'(DELIVERED|COMPLETED|CANCELLED|REFUNDED|FAILED)'/g,
      ),
    ).toHaveLength(5);
    // …and must NOT fire on the tone map, which is bare keys and stays legal.
    expect("  DELIVERED: 'success',\n  REFUNDED: 'error',".match(/'(DELIVERED|COMPLETED|CANCELLED|REFUNDED|FAILED)'/g)).toBe(null);
    expect(/\.filter\(\([^)]*\)\s*=>[^)]*\.status/.test('const live = rows.filter((o) => isLive(o.status));')).toBe(true);
    // …and must not fire on the ID reconciliation that replaced it.
    expect(
      /\.filter\(\([^)]*\)\s*=>[^)]*\.status/.test('const done = rows.filter((o) => !liveIds.has(String(o.id)));'),
    ).toBe(false);
  });
});

describe('the two halves of the feed stay different questions', () => {
  it('history asks for finished orders and the live query asks for open ones', () => {
    const src = code(HOOKS);
    // If either loses its flag the screen silently returns to one list filtered
    // two ways — the pre-fix behaviour, with no visible symptom until an order
    // is old enough to fall off page one.
    expect(src, 'useOrdersInfinite must request history only').toMatch(/live:\s*false/);
    expect(src, 'useLiveOrders must request live orders').toMatch(/live:\s*true/);
  });

  it('the two queries cache under different keys', () => {
    // Same key = one cache entry serving both, and whichever resolved last
    // wins. The bug would look like orders vanishing at random.
    const src = code(HOOKS);
    expect(src).toMatch(/'infinite',\s*'history'/);
    expect(src).toMatch(/customerKeys\.orders,\s*'live'/);
  });
});
