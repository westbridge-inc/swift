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
  // [owner 22 Oct 2026] one minute (was five), as the server's FREE_CANCEL_WINDOW_MIN enforces it.
  { rule: 'rides, parcels, bookings: 1 minute after acceptance', terms: /for one minute after a driver, rider or provider accepts it/, answer: /for 1 minute after a driver, rider or provider accepts/ },
  // [BOOK-S7 · owner B1 28 Oct 2026] appointments: free until 2 hours before, while instant appointment booking is on.
  { rule: 'appointments (switch on): free until 2 hours before, never less than 1 minute after confirmation', terms: /While Swift's instant appointment booking is switched on, an appointment the Business or provider has confirmed \(by accepting it, or automatically when you booked it\) can be cancelled free in the app until 2 hours before it starts, and always for at least one minute after it was confirmed/, answer: /While instant appointment booking is switched on, an appointment the business or provider has confirmed can be cancelled free until 2 hours before it starts \(and always for 1 minute after it was confirmed, /, },
  // [BOOK-P3 · COORD 29 Oct 2026 (b)] the free cancel after the business or provider moves it.
  { rule: 'appointments (switch on): free for 60 minutes after a move by the business or provider', terms: /While instant appointment booking is switched on, if the Business or provider moves your appointment, you can also cancel it free in the app for 60 minutes after you are told, or until it starts if that is sooner, even within 2 hours of its start\./, answer: /and for 60 minutes after the business or provider moves it, or until it starts if that is sooner\); after that, contact the business or provider/ },
  // [TERMS · owner 29 Oct 2026] a time booked from a provider's list of services is an appointment too.
  { rule: 'an appointment can be booked from a provider\'s list of services', terms: /An appointment is a time you book from a Business's listing or from an individual service provider's list of services/, answer: /an appointment the business or provider has confirmed/ },
  { rule: 'any other service job: free until booked', terms: /Any other service job request can be cancelled free in the app until the job is booked/, answer: /Any other service job can be cancelled free until it is booked/ },
  { rule: 'still free when nobody was found or it runs very late', terms: /no driver or rider was found for your Order, or when it is running very late/, answer: /no driver or rider was found, or if it is running very late/ },
  { rule: 'never once on its way', terms: /Once your Order is on its way/, answer: /Once it is on its way, it can’t be cancelled/ },
  { rule: 'paid by MMG and confirmed: the store cancels and refunds', terms: /confirmed your payment, the app cannot cancel[\s\S]*the Business refunds you directly/, answer: /confirmed your payment, ask the store to cancel: the store refunds you directly/ },
  { rule: 'never a fee', terms: /Swift never charges a cancellation fee/, answer: /Swift never charges a cancellation fee/ },
  // [Review S3-2 on #1732] the general MMG rule, not only the confirmed case
  { rule: 'any cancelled MMG-paid order: the store refunds', terms: /If an Order you paid by MMG is cancelled, <b>the Business refunds you directly<\/b>/, answer: /Whenever an order you paid by MMG is cancelled, the store refunds you directly/ },
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

  it('[review S4-1 on #1732] a fee, a charge or a cost is named only to say Swift never charges one', () => {
    const allowed = /never charges a cancellation fee/gi;
    expect(CANCEL_ORDER_FAQ_ANSWER.replace(allowed, '')).not.toMatch(/\b(fees?|charge[sd]?|costs?)\b/i);
  });

  it('[review S3-1 on #1732] the cash checkout caption says free until the store ACCEPTS, never only while it has not been told', () => {
    // [BOOK-WEB #2206] The cart's payment words live in two files now: cartPayment.ts (before an order is placed) and
    // cartPlaced.ts (the confirmation copy, moved word for word). The pin reads both, and the caption is in cartPlaced.
    const read = (file: string) => readFileSync(join(process.cwd(), 'src', 'modules', 'cart', file), 'utf8');
    const cart = `${read('cartPayment.ts')}\n${read('cartPlaced.ts')}`;
    expect(read('cartPlaced.ts')).toContain('Until the store accepts it, you can cancel free from the order screen.');
    expect(cart).not.toMatch(/hasn.t received it/);
  });

  it('the FAQ screen shows this answer, not a copy of its own', () => {
    expect(FAQ_SCREEN).toMatch(/q: 'Can I cancel an order\?',[\s\S]{0,120}a: CANCEL_ORDER_FAQ_ANSWER,/);
  });
});
