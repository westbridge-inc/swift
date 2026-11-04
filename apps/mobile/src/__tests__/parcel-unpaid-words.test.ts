import { describe, expect, it } from 'vitest';
import { parcelUnpaidWords } from '../lib/parcelUnpaidWords';

describe('[BUG-HUNT-2 G02] a parcel unpaid at the door', () => {
  it('tells the rider to bring it back, with what became of their claim', () => {
    expect(parcelUnpaidWords()).toBe('Recorded. Bring the parcel back to the sender.');
    expect(parcelUnpaidWords('AUTO_APPROVED')).toContain('The Swift guarantee covers it.');
    expect(parcelUnpaidWords('PENDING_REVIEW')).toContain('Your claim is under review.');
  });
});
