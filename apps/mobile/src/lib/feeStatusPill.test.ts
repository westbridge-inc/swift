import { describe, expect, it } from 'vitest';
import { feeStatusPill } from './feeStatusPill';

// [FEE-STATUS · owner 25 Oct 2026] A pill names where the fee stands in words: never the code, never "Active".
describe('fee status pill words', () => {
  it('every state has plain words and a tone', () => {
    expect(feeStatusPill('DUE')).toEqual({ label: 'Payment due', tone: 'warning' });
    expect(feeStatusPill('COVERED').label).toBe('Paid');
    for (const state of ['TRIAL', 'PAID', 'UPCOMING', 'COVERED', 'DUE', 'CHECKING', 'FEE_PAUSED', 'SUSPENDED', 'INACTIVE', 'STOPPED', 'CLOSED', 'UNKNOWN'] as const) {
      expect(feeStatusPill(state).label).not.toMatch(/_|^[A-Z]+$/);
      // "Active" only for a next fee whose date is still ahead: never beside a week that is due.
      if (state !== 'UPCOMING') expect(feeStatusPill(state).label).not.toBe('Active');
    }
  });
});
