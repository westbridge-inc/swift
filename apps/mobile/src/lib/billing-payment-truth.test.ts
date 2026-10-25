import { describe, expect, it } from 'vitest';
import { billingStoppedLine, payScreenState } from './billing';

const now = new Date(2026, 7, 12, 12);
const periodEnd = new Date(2026, 7, 15, 12).toISOString();
const trialEnd = new Date(2026, 7, 14, 12).toISOString();

describe('billing dates are not payment evidence', () => {
  it.each([
    { status: 'TRIAL', trialEndsAt: trialEnd, expected: 'Free trial until 14 Aug' },
    { status: 'TRIAL', expected: 'Free trial until 15 Aug' },
    { status: 'ACTIVE', isTrialActive: true, trialEndsAt: trialEnd, expected: 'Free trial until 14 Aug' },
    { status: 'ACTIVE', expected: 'Next bill: 15 Aug' },
  ])('uses neutral dates for $status ($expected)', ({ expected, ...subscription }) => {
    const state = payScreenState({ ...subscription, currentPeriodEnd: periodEnd, amountDueGyd: 0, weeklyFeeGyd: 1200 }, now);
    expect(state.covers).toBe(expected);
    expect(JSON.stringify(state)).not.toMatch(/paid/i);
  });

  it('does not assume a stopped trial was paid when its period date is absent', () => {
    const line = billingStoppedLine({ status: 'TRIAL', autoRenew: false }, 'store', now.getTime());
    expect(line).not.toMatch(/paid/i);
    expect(line).toContain('No more weekly fees will be charged.');
  });
});
