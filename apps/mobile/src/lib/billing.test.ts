import { describe, it, expect } from 'vitest';
import {
  billingPhase,
  isBehind,
  isBlocked,
  shortDate,
  walletLine,
  weeklyFeeGyd,
  weeksCovered,
} from './billing';

describe('billingPhase', () => {
  it('is inactive with no subscription', () => {
    expect(billingPhase(null)).toBe('inactive');
    expect(billingPhase(undefined)).toBe('inactive');
  });

  it('reads trial and grace flags before status', () => {
    // A trialing sub is stored ACTIVE/TRIAL but the flag wins the display.
    expect(billingPhase({ isTrialActive: true, status: 'TRIAL' })).toBe('trial');
    // Grace rides on top of PAST_DUE — the flag is checked first.
    expect(billingPhase({ isInGracePeriod: true, status: 'PAST_DUE' })).toBe('grace');
  });

  it('maps each blocking/overdue status', () => {
    expect(billingPhase({ status: 'ACTIVE' })).toBe('active');
    expect(billingPhase({ status: 'PAST_DUE' })).toBe('past_due');
    expect(billingPhase({ status: 'SUSPENDED' })).toBe('suspended');
    expect(billingPhase({ status: 'CHURNED' })).toBe('churned');
  });

  it('falls back to inactive for unknown/paused/cancelled states', () => {
    expect(billingPhase({ status: 'PAUSED' })).toBe('inactive');
    expect(billingPhase({ status: 'CANCELLED' })).toBe('inactive');
    expect(billingPhase({})).toBe('inactive');
  });
});

describe('isBlocked / isBehind', () => {
  it('blocks only SUSPENDED and CHURNED (paying reinstates)', () => {
    expect(isBlocked({ status: 'SUSPENDED' })).toBe(true);
    expect(isBlocked({ status: 'CHURNED' })).toBe(true);
    expect(isBlocked({ status: 'PAST_DUE' })).toBe(false);
    expect(isBlocked({ status: 'ACTIVE' })).toBe(false);
    expect(isBlocked(null)).toBe(false);
  });

  it('treats grace/PAST_DUE as behind-but-operating', () => {
    expect(isBehind({ isInGracePeriod: true, status: 'PAST_DUE' })).toBe(true);
    expect(isBehind({ status: 'PAST_DUE' })).toBe(true);
    expect(isBehind({ status: 'ACTIVE' })).toBe(false);
    expect(isBehind({ status: 'SUSPENDED' })).toBe(false);
  });
});

describe('weeklyFeeGyd', () => {
  it('prefers payInfo weeklyFeeGyd, then customRate, then weeklyRate', () => {
    expect(weeklyFeeGyd({ weeklyFeeGyd: 12000, weeklyRate: '9999' })).toBe(12000);
    expect(weeklyFeeGyd({ customRate: '15000', weeklyRate: '20000' })).toBe(15000);
    expect(weeklyFeeGyd({ weeklyRate: '20000' })).toBe(20000);
  });

  it('is 0 (never NaN) when absent', () => {
    expect(weeklyFeeGyd(null)).toBe(0);
    expect(weeklyFeeGyd({})).toBe(0);
  });
});

describe('weeksCovered', () => {
  it('floors whole weeks of coverage', () => {
    expect(weeksCovered(24000, 12000)).toBe(2);
    expect(weeksCovered(30000, 12000)).toBe(2); // 2.5 → 2, never over-promise
  });

  it('is 0 when the fee or balance is missing/zero', () => {
    expect(weeksCovered(0, 12000)).toBe(0);
    expect(weeksCovered(12000, 0)).toBe(0);
    expect(weeksCovered(null, null)).toBe(0);
  });
});

describe('walletLine', () => {
  it('is null when nothing is banked', () => {
    expect(walletLine(0, 12000)).toBeNull();
    expect(walletLine(null, 12000)).toBeNull();
  });

  it('adds a coverage clause when the fee is known', () => {
    expect(walletLine(24000, 12000)).toBe('$24,000 banked · covers 2 weeks');
    expect(walletLine(12000, 12000)).toBe('$12,000 banked · covers 1 week');
  });

  it('drops the coverage clause when the fee is unknown', () => {
    expect(walletLine(5000, 0)).toBe('$5,000 banked');
  });
});

describe('shortDate', () => {
  it('formats to "D Mon"', () => {
    // Build from local noon so the assertion holds in any runner timezone.
    const iso = new Date(2026, 7, 12, 12, 0, 0).toISOString();
    expect(shortDate(iso)).toBe('12 Aug');
  });

  it('is empty for missing/invalid input (never "Invalid Date")', () => {
    expect(shortDate(null)).toBe('');
    expect(shortDate(undefined)).toBe('');
    expect(shortDate('not-a-date')).toBe('');
  });
});
