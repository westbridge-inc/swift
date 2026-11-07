// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { billingHeadline, billingPill, feeStatusPillWords, subscriptionWords } from './subscription-words';
import { subscriptionWords as weeklyFeeWords, type FeeStatusState } from './weekly-fee';
import { feeStatusPill } from '../../../mobile/src/lib/feeStatusPill';

// The Orders home names the subscription state from this small file so the
// Orders page does not load the whole weekly-fee module (perf-budget). Its
// words must stay the weekly-fee page's words, for every state the API has.
const schema = readFileSync(new URL('../../../api/prisma/schema.prisma', import.meta.url), 'utf8');
const statuses = /enum SubscriptionStatus \{([^}]*)\}/.exec(schema)?.[1]
  ?.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean) ?? [];

describe('the subscription state reads the same on the Orders home and the weekly-fee page', () => {
  it('reads every status the API has', () => {
    expect(statuses.length).toBeGreaterThanOrEqual(7);
  });

  it.each([...statuses, 'SOMETHING_NEW', ''])('%s', (status) => {
    expect(subscriptionWords(status)).toBe(weeklyFeeWords(status));
    expect(subscriptionWords(status)).not.toMatch(/_|^[A-Z]+$/);
  });

  it('the Orders home takes its words from the small file, never the whole weekly-fee module', () => {
    const home = readFileSync(new URL('../components/orders-home.tsx', import.meta.url), 'utf8');
    expect(home).toContain("from '@/lib/subscription-words'");
    expect(home).not.toMatch(/from '@\/lib\/weekly-fee'/);
  });

  // [FEE-STATUS · owner 25 Oct 2026] The Billing pill names where the fee stands, in the weekly-fee page's words.
  const states: FeeStatusState[] = ['TRIAL', 'PAID', 'UPCOMING', 'COVERED', 'DUE', 'CHECKING', 'FEE_PAUSED', 'SUSPENDED', 'INACTIVE', 'STOPPED', 'CLOSED', 'UNKNOWN'];
  it.each(states)('fee status %s has the phone\'s pill words', (state) => {
    expect(feeStatusPillWords(state)).toEqual(feeStatusPill(state));
  });
  it("the tile shows the API's feeStatus, and without it the state's words, never a date", () => {
    const due = { status: 'ACTIVE', feeStatus: { state: 'DUE' as const, headline: 'Payment due since 13 Oct 2026', detail: null, date: null } };
    expect(billingPill(due)).toEqual({ label: 'Payment due', tone: 'warning' });
    expect(billingHeadline(due)).toBe('Payment due since 13 Oct 2026');
  });
  // [REVIEW-F S4-1 on #2100] Without the API's feeStatus the tile works it out by the same rules (lib/fee-status
  // feeStatusOf): never "Active" or a bare status word on a week that is due.
  it('without feeStatus a week past its date is due on the tile, never "Active"', () => {
    const passed = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const row = { status: 'ACTIVE', nextBillingDate: passed, amountDueGyd: 1200 };
    expect(billingPill(row)).toEqual({ label: 'Payment due', tone: 'warning' });
    expect(billingHeadline(row)).toMatch(/^Payment due since \d{1,2} [A-Z][a-z]{2,3} \d{4}$/);
    const ahead = { status: 'ACTIVE', nextBillingDate: new Date(Date.now() + 3 * 86_400_000).toISOString(), amountDueGyd: 0 };
    expect(billingPill(ahead).label).toBe('Active');
    expect(billingHeadline(ahead)).toMatch(/^Next weekly fee due on /);
    expect(billingHeadline({ status: 'PAST_DUE', nextBillingDate: passed, amountDueGyd: 1200 })).not.toBe('Weekly fee overdue');
  });
});
