import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMS_BODY } from '@/legal/generated';
import { CANCEL_EARLY_STEP, CANCEL_FREE_SHORT, CANCEL_ORDER_ANSWER } from './cancel-policy-copy';

// ---------------------------------------------------------------------------
// [Terms 2026-10-15 §7 · counsel packet E5] The public FAQ said "after the store starts work a
// cancellation may carry a cost, and the app tells you the exact amount", and How it works said
// cancelling is "typically free … the app confirms the exact outcome". Swift has no cancellation fee:
// a cancel is free or refused. Each rule is checked in BOTH the served Terms (the site's own snapshot)
// and the site's words, so a later Terms change that drops a rule fails here.
// ---------------------------------------------------------------------------

const TERMS_S7 = (() => {
  const m = /<h2>7\. Cancellations and refunds<\/h2>\s*<p>([\s\S]*?)<\/p>/.exec(TERMS_BODY);
  if (!m) throw new Error('Terms §7 not found in the legal snapshot');
  return m[1]!;
})();
const page = (...p: string[]) => readFileSync(join(process.cwd(), 'src', 'app', '(marketing)', ...p), 'utf8');
const FAQ_PAGE = page('faq', 'page.tsx');
const HOW_PAGE = page('how-it-works', 'page.tsx');

const RULES: Array<{ rule: string; terms: RegExp; answer: RegExp }> = [
  { rule: 'a store order is free until the business accepts it', terms: /cancel an Order free while the Business has not yet accepted it/, answer: /free, while the business has not accepted your order/ },
  { rule: 'after acceptance: no in-app cancel, contact the business', terms: /can no longer be cancelled in the app: contact the Business/, answer: /can no longer be cancelled in the app or here: contact the business/ },
  // [owner 22 Oct 2026] one minute (was five), as the server's FREE_CANCEL_WINDOW_MIN enforces it.
  { rule: 'rides, parcels, bookings: 1 minute after acceptance', terms: /for one minute after a driver, rider or provider accepts it/, answer: /for 1 minute after a driver, rider or provider accepts/ },
  { rule: 'a service job: free until booked', terms: /free in the app until the job is booked/, answer: /service job can be cancelled free until it is booked/ },
  { rule: 'still free when nobody was found or it runs very late', terms: /no driver or rider was found for your Order, or when it is running very late/, answer: /no driver or rider was found, or if it is running very late/ },
  { rule: 'never once on its way', terms: /Once your Order is on its way/, answer: /Once it is on its way, it can no longer be cancelled/ },
  { rule: 'paid by MMG and confirmed: the business cancels and refunds', terms: /confirmed your payment, the app cannot cancel[\s\S]*the Business refunds you directly/, answer: /confirmed your payment, ask the business to cancel: the business refunds you directly/ },
  { rule: 'never a fee', terms: /Swift never charges a cancellation fee/, answer: /Swift never charges a cancellation fee/ },
  // [Review S3-2 on #1732] the general MMG rule, not only the confirmed case
  { rule: 'any cancelled MMG-paid order: the business refunds', terms: /If an Order you paid by MMG is cancelled, <b>the Business refunds you directly<\/b>/, answer: /Whenever an order you paid by MMG is cancelled, the business refunds you directly/ },
];

const OLD = /may carry a cost|exact amount|typically free|exact outcome|first few minutes|may not be available|cancellation fee may|late-cancellation|possible fee|costs nothing inside|inside it costs|clock counting down/i;
const WELCOME_PAGE = page('welcome', 'page.tsx');

describe('the site says what Terms §7 says about cancelling', () => {
  it.each(RULES)('FAQ: $rule', ({ terms, answer }) => {
    expect(TERMS_S7).toMatch(terms);
    expect(CANCEL_ORDER_ANSWER).toMatch(answer);
  });

  it('How it works: free until the store accepts, then contact the store; MMG-confirmed goes to the store; never a fee', () => {
    expect(CANCEL_EARLY_STEP).toMatch(/Cancel free from the order screen while the store has not accepted your order/);
    expect(CANCEL_EARLY_STEP).toMatch(/After that, contact the store/);
    expect(CANCEL_EARLY_STEP).toMatch(/confirmed your payment, ask the store to cancel: the store refunds you directly/);
    expect(CANCEL_EARLY_STEP).toMatch(/Swift never charges a cancellation fee/);
  });

  it('no page words a fee, an amount, a "typically" or a window with a clock', () => {
    for (const text of [CANCEL_ORDER_ANSWER, CANCEL_EARLY_STEP, CANCEL_FREE_SHORT, FAQ_PAGE, HOW_PAGE, WELCOME_PAGE]) expect(text).not.toMatch(OLD);
  });

  it('[review S4-1 on #1732] a fee, a charge or a cost is named only to say Swift never charges one', () => {
    for (const text of [CANCEL_ORDER_ANSWER, CANCEL_EARLY_STEP, CANCEL_FREE_SHORT]) {
      expect(text.replace(/never charges a cancellation fee/gi, '')).not.toMatch(/\b(fees?|charge[sd]?|costs?)\b/i);
    }
  });

  it('[review S3-1 on #1732] the /welcome card says the rule from the copy module', () => {
    expect(CANCEL_FREE_SHORT).toBe('Cancel free until the store accepts your order. Swift never charges a cancellation fee.');
    expect(WELCOME_PAGE).toMatch(/body: CANCEL_FREE_SHORT,/);
  });

  // [owner 22 Oct 2026] The public Refunds page (outside LEGAL_VERSION) names the same one-minute window as Terms §7
  // and the server (FREE_CANCEL_WINDOW_MIN): never the old five minutes.
  it('the Refunds page names the one-minute window the Terms name', () => {
    const refunds = readFileSync(join(process.cwd(), 'src', 'app', 'legal', 'refunds', 'page.tsx'), 'utf8').replace(/\s+/g, ' ');
    expect(TERMS_S7).toMatch(/for one minute after a driver, rider or provider accepts it/);
    expect(refunds).toContain('can be cancelled free at any time while nobody has accepted them, and for 1 minute after a driver, rider or provider accepts them.');
    expect(refunds).not.toMatch(/(5|five) minutes after a driver/i);
  });

  it('both pages show these words, not copies of their own', () => {
    expect(FAQ_PAGE).toMatch(/q: 'Can I cancel an order\?',\s*a: <>\{CANCEL_ORDER_ANSWER\}<\/>,/);
    expect(HOW_PAGE).toMatch(/\['Change your mind early', CANCEL_EARLY_STEP\]/);
  });
});
