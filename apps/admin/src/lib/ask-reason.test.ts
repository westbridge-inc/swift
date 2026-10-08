import { describe, it, expect } from 'vitest';
import * as askReasonModule from '@/lib/ask-reason';
import { reasonTooShort, REASON_MIN } from '@/lib/ask-reason';

// ---------------------------------------------------------------------------
// [ADM-006] THE OPERATOR STATES WHY, OR NOTHING HAPPENS.
//
// The failure mode to guard was never "no reason sent" — it was "a reason
// invented on the operator's behalf" ('Suspended by admin', hard-coded on every
// ban). [MISSION CONTROL · MONEY] The browser prompt that asked is retired: the
// in-page panel asks, and a cancelled panel resolves nothing and runs nothing
// (graded as behaviour in components/mc/primitives.test.tsx). What is left here
// is the length rule screens with their own reason input share with the server.
// ---------------------------------------------------------------------------

describe('[ADM-006] the reason length rule', () => {
  it('matches the server: fewer than REASON_MIN characters, after trimming, is not a reason', () => {
    expect(REASON_MIN).toBe(12);
    expect(reasonTooShort('ok')).toBe(true);
    expect(reasonTooShort('   too short   ')).toBe(true);
    expect(reasonTooShort('Three written warnings, then a no-show')).toBe(false);
  });

  it('[MC-MONEY] the browser-prompt helper is gone — no page can fall back to it', () => {
    expect('askReason' in askReasonModule).toBe(false);
  });
});
