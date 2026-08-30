import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promiseLine, promiseNote, rangeLabel } from './promise';

// ---------------------------------------------------------------------------
// [ALG-12] The promise as the screens read it: a range, never a passed time
// shown as still coming, the server's reason verbatim, nothing invented.
// ---------------------------------------------------------------------------

const view = (start: string, end: string, extra: Partial<{ revisedAt: string | null; revisionReason: string | null; revisions: number }> = {}) => ({
  at: start, windowStart: start, windowEnd: end, revisedAt: null, revisionReason: null, revisions: 0, ...extra,
});

describe('the promise line', () => {
  const start = '2026-08-30T23:35:00.000Z';
  const end = '2026-08-30T23:55:00.000Z';

  it('is a RANGE while the window is ahead — recomputed from the clock it is handed', () => {
    const line = promiseLine(view(start, end), Date.parse('2026-08-30T23:00:00Z'));
    expect(line?.kind).toBe('window');
    expect(line?.label).toMatch(/^Arriving .+–.+$/);
    expect(line?.label).toBe(`Arriving ${rangeLabel(new Date(start), new Date(end))}`);
  });

  it('never shows a passed window as still coming (R-12.2.4)', () => {
    const line = promiseLine(view(start, end), Date.parse('2026-08-30T23:56:00Z'));
    expect(line).toMatchObject({ kind: 'passed', label: 'Running later than promised — arriving shortly' });
    // One minute before the end it is still the window.
    expect(promiseLine(view(start, end), Date.parse('2026-08-30T23:54:00Z'))?.kind).toBe('window');
  });

  it('renders nothing for nothing — a missing or garbage promise is not a time', () => {
    expect(promiseLine(null, Date.now())).toBeNull();
    expect(promiseLine(view('nope', end), Date.now())).toBeNull();
    expect(promiseLine(view(end, start), Date.now())).toBeNull();
  });

  it('the note under the range is the server\'s reason, verbatim, only once the promise has moved', () => {
    expect(promiseNote(view(start, end))).toBeNull();
    expect(promiseNote(view(start, end, { revisions: 1, revisionReason: 'the kitchen is running behind' }))).toBe('Updated — the kitchen is running behind');
    expect(promiseNote(view(start, end, { revisions: 2, revisionReason: null }))).toBe('Updated');
  });
});

describe('the screens read the promise from the server, on the clock, in ink', () => {
  const delivery = readFileSync(join(process.cwd(), 'src/modules/orders/screens/DeliveryScreen.tsx'), 'utf8');
  const home = readFileSync(join(process.cwd(), 'src/modules/shop/screens/HomeScreen.tsx'), 'utf8');

  it('the tracking screen renders the promise line from the server view against its own ticking clock, and the note under it', () => {
    expect(delivery).toContain("const promise = o.fulfillment === 'DELIVERY' && !cancelled && !failed && !complete ? promiseLine(o.promise, nowTs) : null;");
    expect(delivery).toContain('const promiseUpdate = promiseNote(o.promise);');
    expect(delivery).toContain('testID="promise-range"');
    // Ink, never brand: the range carries no tone prop.
    expect(delivery).toMatch(/<T variant="label" style=\{\{ marginTop: space\.xs \}\} testID="promise-range">/);
    // A revision reaches the screen live and refetches the order.
    expect(delivery).toContain("s.on('order:promise_revised', onStatus);");
    expect(delivery).toContain("s.off('order:promise_revised', onStatus);");
  });

  it('the Home live-order card shows the same range from the same server field', () => {
    expect(home).toContain('const promise = promiseLine(order.promise, now);');
    expect(home).toContain("{promise && !hold ? (");
  });

  it('no screen computes an arrival time from a minutes field any more', () => {
    for (const src of [delivery, home]) {
      expect(src).not.toMatch(/Date\.now\(\)\s*\+\s*[^;]*estimatedDeliveryTime/);
    }
  });
});
