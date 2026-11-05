import { describe, expect, it } from 'vitest';
import { parcelUnpaidWords } from '../lib/parcelUnpaidWords';

describe('[BUG-HUNT-2 G02] a parcel unpaid at the door', () => {
  it('tells the rider to bring it back, that a person will review, and that Swift may help, with no promise', () => {
    expect(parcelUnpaidWords()).toBe('Recorded. Bring the parcel back to the sender.');
    // An older server can still answer AUTO_APPROVED: the phone never turns that into a promise.
    for (const status of ['AUTO_APPROVED', 'PENDING_REVIEW']) {
      expect(parcelUnpaidWords(status)).toContain('A person will review this, and Swift may help.');
      expect(parcelUnpaidWords(status)).not.toMatch(/will pay/i);
    }
  });
});
