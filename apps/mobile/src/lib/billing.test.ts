import { describe, it, expect } from 'vitest';
import {
  billingPhase,
  isBehind,
  isBlocked,
  shortDate,
  walletLine,
  weeklyFeeGyd,
  weeksCovered,
  payScreenState,
  hoursUntil,
  daysUntil,
  sanQrPayload,
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

// ---------------------------------------------------------------------------
// The pay screen [PAY-1 · Swift Pay §1a/1b]. Four bands, one layout.
// The assertions that matter most are the NEGATIVE ones: what the screen
// refuses to say when the server did not tell it. A billing screen that
// guesses a deadline is worse than one that says less.
// ---------------------------------------------------------------------------

describe('payScreenState — the four bands', () => {
  const NOW = new Date(2026, 7, 12, 12, 0, 0); // Wed 12 Aug 2026, local noon
  const iso = (d: number, h = 12) => new Date(2026, 7, d, h, 0, 0).toISOString();

  it('covered: a big zero is the reward for paying, and the fee ahead is stated once', () => {
    const s = payScreenState(
      { status: 'ACTIVE', weeklyFeeGyd: 10_000, amountDueGyd: 0, currentPeriodEnd: iso(15) },
      NOW,
    );
    expect(s.band).toBe('active');
    expect(s.tone).toBe('covered');
    expect(s.eyebrow).toBe('NOTHING DUE NOW');
    expect(s.amountGyd).toBe(0);
    expect(s.covers).toBe('Paid through 15 Aug');
    expect(s.title).toBe('You are covered');
    // The fee ahead appears in the band, NOT as a second hero number.
    expect(s.body).toContain('$10,000');
    expect(s.extra).toBeUndefined();
  });

  it('due: gentle, names the weekday, and names no consequence yet', () => {
    const s = payScreenState(
      { status: 'ACTIVE', weeklyFeeGyd: 10_000, amountDueGyd: 10_000, currentPeriodEnd: iso(14) },
      NOW,
    );
    expect(s.band).toBe('due');
    expect(s.tone).toBe('owed');
    expect(s.eyebrow).toBe('DUE FRIDAY');
    expect(s.title).toBe('Due in 2 days');
    expect(s.amountGyd).toBe(10_000);
    // The design is explicit: at T-3 no consequence is named.
    expect(s.body).not.toMatch(/paus|suspend|clos|stop/i);
  });

  it('due today reads "Due today", never "Due in 0 days"', () => {
    const s = payScreenState(
      { status: 'ACTIVE', weeklyFeeGyd: 10_000, amountDueGyd: 10_000, currentPeriodEnd: iso(12) },
      NOW,
    );
    expect(s.title).toBe('Due today');
    expect(s.eyebrow).toBe('DUE NOW');
  });

  it('grace: names the consequence and the hour exactly once', () => {
    const s = payScreenState(
      {
        status: 'PAST_DUE', isInGracePeriod: true, weeklyFeeGyd: 10_000,
        amountDueGyd: 10_000, currentPeriodEnd: iso(12), gracePeriodEnd: iso(13, 19),
      },
      NOW,
    );
    expect(s.band).toBe('grace');
    expect(s.title).toBe('Grace period · 31 hours left');
    expect(s.tone).toBe('owed'); // amber, never red — nothing on this screen turns red
  });

  it('grace WITHOUT a server deadline prints no countdown at all', () => {
    // The honesty rule. An invented "48 hours left" on a screen about someone's
    // livelihood is the kind of lie that ends a vendor relationship.
    const s = payScreenState(
      { status: 'PAST_DUE', isInGracePeriod: true, weeklyFeeGyd: 10_000, amountDueGyd: 10_000 },
      NOW,
    );
    expect(s.band).toBe('grace');
    expect(s.title).toBe('Grace period');
    expect(s.title).not.toMatch(/\d/);
  });

  it('paused: not a wall — it says what turns the store back on, then what is kept', () => {
    const s = payScreenState(
      { status: 'SUSPENDED', weeklyFeeGyd: 10_000, amountDueGyd: 10_000, currentPeriodEnd: iso(12) },
      NOW,
    );
    expect(s.band).toBe('paused');
    expect(s.tone).toBe('paused');
    expect(s.title).toBe('New orders are paused');
    expect(s.body).toContain('$10,000');

    // PINV-8 as the vendor reads it. The server-side proof of this exact
    // sentence is api/src/__tests__/billing-suspension-retention.test.ts.
    expect(s.extra).toContain('this screen');
    expect(s.extra).toContain('receipts');
    expect(s.extra).toContain('earnings');
    expect(s.extra).toContain('Orders already in the kitchen still go out');
  });

  it('never prints a paid-through date the server did not send', () => {
    const s = payScreenState({ status: 'ACTIVE', weeklyFeeGyd: 10_000, amountDueGyd: 0 }, NOW);
    expect(s.covers).toBe('');
    expect(s.body).not.toMatch(/Invalid|NaN|undefined/);
  });

  it('survives a null subscription without inventing anything', () => {
    const s = payScreenState(null, NOW);
    expect(s.band).toBe('active');
    expect(s.amountGyd).toBe(0);
    expect(s.covers).toBe('');
    expect(JSON.stringify(s)).not.toMatch(/NaN|Invalid|undefined/);
  });
});

describe('hoursUntil / daysUntil — null means "print nothing", never zero', () => {
  const NOW = new Date(2026, 7, 12, 12, 0, 0);
  it('returns null for missing, invalid and already-past instants', () => {
    expect(hoursUntil(null, NOW)).toBeNull();
    expect(hoursUntil('not-a-date', NOW)).toBeNull();
    expect(hoursUntil(new Date(2026, 7, 11).toISOString(), NOW)).toBeNull();
    expect(daysUntil(undefined, NOW)).toBeNull();
    expect(daysUntil('nope', NOW)).toBeNull();
  });
  it('floors hours so we never over-promise time remaining', () => {
    expect(hoursUntil(new Date(2026, 7, 12, 14, 59, 0).toISOString(), NOW)).toBe(2);
  });
});

describe('sanQrPayload', () => {
  it('builds the agent-scannable payload from a valid SAN', () => {
    expect(sanQrPayload('1234567890')).toBe('SWIFTSAN:1234567890');
    expect(sanQrPayload('123-456-7890')).toBe('SWIFTSAN:1234567890');
  });
  it('refuses to render a QR that resolves to nothing', () => {
    expect(sanQrPayload(null)).toBeNull();
    expect(sanQrPayload('')).toBeNull();
    expect(sanQrPayload('12345')).toBeNull();
  });
});
