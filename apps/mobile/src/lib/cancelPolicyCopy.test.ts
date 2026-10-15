import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANCEL_ORDER_FAQ_ANSWER } from './cancelPolicyCopy';

// ---------------------------------------------------------------------------
// [Terms 2026-10-15 §7 · counsel packet E5] The in-app help answer to "Can I cancel an order?" said
// "within the first few minutes … after the store starts preparing, cancellation may not be
// available" — a rule that no longer exists. It must say what the served Terms say: free or refused,
// never a fee. Each rule below is checked in BOTH texts, so a later Terms change that drops a rule
// fails here and sends someone to re-word the answer.
// ---------------------------------------------------------------------------

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const LEGAL = read('..', 'api', 'src', 'modules', 'legal', 'legal.routes.ts');
const TERMS_S7 = (() => {
  const m = /<h2>7\. Cancellations and refunds<\/h2>\s*<p>([\s\S]*?)<\/p>/.exec(LEGAL);
  if (!m) throw new Error('Terms §7 not found in legal.routes.ts');
  return m[1]!;
})();
const FAQ_SCREEN = read('src', 'modules', 'profile', 'screens', 'FaqScreen.tsx');

const RULES: Array<{ rule: string; terms: RegExp; answer: RegExp }> = [
  { rule: 'a store order is free until the store accepts it', terms: /cancel an Order free while the Business has not yet accepted it/, answer: /free, while the store hasn’t accepted your order/ },
  { rule: 'after acceptance: no in-app cancel, contact the store', terms: /can no longer be cancelled in the app: contact the Business/, answer: /can’t be cancelled in the app: contact the store/ },
  { rule: 'rides, parcels, bookings: 5 minutes after acceptance', terms: /five minutes after a driver, rider or provider accepts it/, answer: /for 5 minutes after a driver, rider or provider accepts/ },
  { rule: 'a service job: free until booked', terms: /free in the app until the job is booked/, answer: /service job can be cancelled free until it is booked/ },
  { rule: 'still free when nobody was found or it runs very late', terms: /no driver or rider was found for your Order, or when it is running very late/, answer: /no driver or rider was found, or if it is running very late/ },
  { rule: 'never once on its way', terms: /Once your Order is on its way/, answer: /Once it is on its way, it can’t be cancelled/ },
  { rule: 'paid by MMG and confirmed: the store cancels and refunds', terms: /confirmed your payment, the app cannot cancel[\s\S]*the Business refunds you directly/, answer: /confirmed your payment, ask the store to cancel: the store refunds you directly/ },
  { rule: 'never a fee', terms: /Swift never charges a cancellation fee/, answer: /Swift never charges a cancellation fee/ },
];

describe('the in-app "Can I cancel an order?" answer says what Terms §7 says', () => {
  it.each(RULES)('$rule', ({ terms, answer }) => {
    expect(TERMS_S7).toMatch(terms);
    expect(CANCEL_ORDER_FAQ_ANSWER).toMatch(answer);
  });

  it('names no fee, no countdown window and no "may not be available"', () => {
    const OLD = /first few minutes|may not be available|starts preparing|may carry a cost|exact amount|late-cancellation|possible fee/i;
    expect(CANCEL_ORDER_FAQ_ANSWER).not.toMatch(OLD);
    expect(FAQ_SCREEN).not.toMatch(OLD);
  });

  it('the FAQ screen shows this answer, not a copy of its own', () => {
    expect(FAQ_SCREEN).toMatch(/q: 'Can I cancel an order\?',[\s\S]{0,120}a: CANCEL_ORDER_FAQ_ANSWER,/);
  });
});
