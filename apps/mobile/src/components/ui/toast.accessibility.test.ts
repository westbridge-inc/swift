import { describe, it, expect } from 'vitest';
import { TOAST_MS, QUEUE_ALLOWANCE_MS, toastDurationMs } from './toast-duration';

// ---------------------------------------------------------------------------
// [F-027-06] A screen reader needs longer than an eye does.
//
// Every toast was removed after a flat 2.6s. That is fine for a glance, and
// wrong for assistive technology: a `polite` announcement queues behind
// whatever is currently speaking, and a long reason takes longer to speak than
// to read — so the message could be gone before it was ever reached. Manual
// dismissal can only make the window shorter, never longer.
//
// F-243 added the alert role and the live region, which is what made the toast
// announceable at all. This is the other half: making it still be there.
// ---------------------------------------------------------------------------

const VISUAL_MS = 2600;

describe('toast duration [F-027-06]', () => {
  it('is unchanged for sighted users — the fix ships no visible difference', () => {
    for (const tone of ['success', 'error', 'info'] as const) {
      expect(toastDurationMs(tone, 'Saved', 'Some longer description here', false), tone).toBe(VISUAL_MS);
    }
  });

  it('an ERROR persists until dismissed when a screen reader is on', () => {
    // An error nobody heard is the one that matters most. null = no timer.
    expect(toastDurationMs('error', 'Could not send', 'Check your connection')).toBe(VISUAL_MS);
    expect(toastDurationMs('error', 'Could not send', 'Check your connection', true)).toBeNull();
  });

  it('a longer message gets a longer window, and it grows with the text', () => {
    const short = toastDurationMs('info', 'Saved', undefined, true)!;
    const long = toastDurationMs('info', 'Saved', 'x'.repeat(400), true)!;
    expect(long).toBeGreaterThan(short);
    // Long enough to actually speak 400+ characters at ~12 chars/sec.
    expect(long).toBeGreaterThan(30_000);
  });

  it('never shortens the window below what a sighted user already gets', () => {
    for (const title of ['', 'ok', 'Saved']) {
      expect(toastDurationMs('success', title, undefined, true)!).toBeGreaterThanOrEqual(VISUAL_MS);
    }
  });
});

describe('[F-028-18] the polite queue is part of the window', () => {
  it('a short success toast waits for what is queued AHEAD of it', () => {
    // Production shape: two toasts land close together under a reader. The
    // second's own speech is short, but it speaks only after the first — so
    // its removal window must carry the wait, or "Saved" vanishes unheard.
    const alone = toastDurationMs('success', 'Saved', undefined, true, 0)!;
    const queued = toastDurationMs('success', 'Saved', undefined, true, 1)!;
    // The allowance extends the SPEECH window (own speech + queue wait), not
    // the floored display minimum — a short toast alone is floored at
    // TOAST_MS, so the correct claim is: queued strictly exceeds alone, and
    // by the queue wait measured from the speech time.
    expect(queued).toBeGreaterThan(alone);
    expect(queued - QUEUE_ALLOWANCE_MS).toBeLessThanOrEqual(alone);
    const deepQueue = toastDurationMs('success', 'Saved', undefined, true, 3)!;
    expect(deepQueue).toBe(queued + 2 * QUEUE_ALLOWANCE_MS);
  });

  it('sighted timing is untouched by the queue', () => {
    expect(toastDurationMs('success', 'Saved', undefined, false, 3)).toBe(TOAST_MS);
  });

  it('errors persist regardless of queue depth', () => {
    expect(toastDurationMs('error', 'Payment failed', 'Try again', true, 5)).toBeNull();
  });
});
