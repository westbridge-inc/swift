import { describe, it, expect, vi } from 'vitest';
import { askReason, REASON_MIN } from '@/lib/ask-reason';

// ---------------------------------------------------------------------------
// [ADM-006] THE OPERATOR STATES WHY, OR NOTHING HAPPENS.
//
// The server now refuses a consequential action without a reason. That alone
// would not have fixed this console, because it DID send one — the literal
// string 'Suspended by admin', hard-coded at the call site, on every ban and
// every suspension. A reason nobody was asked for is a field, not an
// explanation.
//
// So the failure mode to guard is not "no reason sent". It is "a reason
// invented on the operator's behalf". A cancelled prompt must return NOTHING,
// so the caller does nothing — never a default, which is exactly the shape
// that produced the canned strings.
// ---------------------------------------------------------------------------

const REAL = 'Three written warnings, then a no-show on a paid booking';

describe('[ADM-006] askReason', () => {
  it('returns the operator’s own words, trimmed', () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue(`  ${REAL}  `));
    expect(askReason({ action: 'ban this account' })).toBe(REAL);
  });

  it('a CANCELLED prompt returns nothing — it never invents a reason', () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue(null));
    vi.stubGlobal('alert', vi.fn());
    expect(askReason({ action: 'ban this account' })).toBeNull();
  });

  it('a word is not a reason: too short returns nothing, and says so, rather than sending it', () => {
    const alert = vi.fn();
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('bad'));
    vi.stubGlobal('alert', alert);
    expect(askReason({ action: 'ban this account' })).toBeNull();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0]![0])).toMatch(/Nothing was changed/);
  });

  it('an empty or whitespace answer is a cancellation too — not an empty reason', () => {
    vi.stubGlobal('alert', vi.fn());
    for (const answer of ['', '   ', '\n']) {
      vi.stubGlobal('prompt', vi.fn().mockReturnValue(answer));
      expect(askReason({ action: 'ban this account' })).toBeNull();
    }
  });

  it('the question names the action and the subject, and states the length the server wants', () => {
    const prompt = vi.fn().mockReturnValue(REAL);
    vi.stubGlobal('prompt', prompt);
    askReason({ action: 'suspend this account', subject: 'Ravi Persaud' });
    const asked = String(prompt.mock.calls[0]![0]);
    expect(asked).toContain('suspend this account');
    expect(asked).toContain('Ravi Persaud');
    expect(asked).toContain(String(REASON_MIN));
    expect(asked).toMatch(/permanent record/);
  });
});
