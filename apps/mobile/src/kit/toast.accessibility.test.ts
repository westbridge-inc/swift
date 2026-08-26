import { describe, it, expect } from 'vitest';
import { TOAST_MS, QUEUE_ALLOWANCE_MS, toastDurationMs } from './toast-duration';

// ---------------------------------------------------------------------------
// [F-027-06] A screen reader needs longer than an eye does. Kit copy of the
// legacy toast-duration contract — the policy travelled with the DRIFT-09
// port and must keep exactly the same promises.
// ---------------------------------------------------------------------------

const VISUAL_MS = 2600;

describe('kit toast duration [F-027-06]', () => {
  it('is unchanged for sighted users — the port ships no visible difference', () => {
    for (const tone of ['success', 'error', 'info'] as const) {
      expect(toastDurationMs(tone, 'Saved', 'Some longer description here', false), tone).toBe(VISUAL_MS);
    }
    expect(TOAST_MS).toBe(VISUAL_MS);
  });

  it('an ERROR persists until dismissed when a screen reader is on', () => {
    expect(toastDurationMs('error', 'Could not send', 'Check your connection')).toBe(VISUAL_MS);
    expect(toastDurationMs('error', 'Could not send', 'Check your connection', true)).toBeNull();
  });

  it('a long reason gets a window sized to speech, never shorter than the visual one', () => {
    const short = toastDurationMs('success', 'Saved', undefined, true)!;
    expect(short).toBeGreaterThanOrEqual(VISUAL_MS);
    const long = toastDurationMs(
      'info',
      'Order updated',
      'The store swapped an item and your total changed — review the substitution before it is picked up.',
      true,
    )!;
    expect(long).toBeGreaterThan(short);
  });

  it('a queued-ahead announcement extends the window [F-028-18]', () => {
    const alone = toastDurationMs('success', 'Saved', undefined, true, 0)!;
    const queued = toastDurationMs('success', 'Saved', undefined, true, 2)!;
    expect(queued - alone).toBeGreaterThanOrEqual(QUEUE_ALLOWANCE_MS);
  });
});
