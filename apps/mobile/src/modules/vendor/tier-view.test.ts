import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { NO_LIMITS_LINE, WAYS_IN_LINE, registrationLine } from './tier-view';

describe('seller status helpers', () => {
  it('says where the registration stands', () => {
    expect(registrationLine({ registration: { onFile: true, recordId: 'r' } })).toBe('Business registration on file.');
    expect(registrationLine({ registration: { onFile: false, submission: null } })).toBe('No business registration on file yet.');
    expect(registrationLine({ registration: { onFile: false, submission: { status: 'PENDING', submittedAt: 'x' } } })).toBe('Business registration submitted — under review.');
  });

  // [REVIEW-F S4-1] An own-name trader needs no registration, so "not on file yet" would read as something still owed.
  // Builds before 13 and an older server send no tradesUnderOwnName: the plain line stays.
  it('tells an own-name trader none is needed, not "not on file yet"', () => {
    expect(registrationLine({ registration: { onFile: false, submission: null }, tradesUnderOwnName: true })).toBe('This store trades under its owner’s own name, so it needs no business registration.');
    expect(registrationLine({ registration: { onFile: false, submission: null }, tradesUnderOwnName: false })).toBe('No business registration on file yet.');
    expect(registrationLine({ registration: { onFile: true, recordId: 'r' }, tradesUnderOwnName: true })).toBe('Business registration on file.');
    expect(registrationLine({ registration: { onFile: false, submission: { status: 'PENDING', submittedAt: 'x' } }, tradesUnderOwnName: true })).toBe('Business registration submitted — under review.');
  });
});

// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (a) — a DELIBERATE change] The self-declared tier is removed: the screen names
// no tier, no cap, no declaration, and nothing on the store's Account opens it any more.
describe('[CHECKLIST-LEGAL (a)] no tier is shown', () => {
  const screen = readFileSync(new URL('./screens/VendorTierScreen.tsx', import.meta.url), 'utf8');
  const account = readFileSync(new URL('./screens/VendorAccountScreen.tsx', import.meta.url), 'utf8');
  it('the screen says there are no limits and names both ways in', () => {
    expect(NO_LIMITS_LINE).toBe('No order or sales limits apply to any store on Swift.');
    expect(WAYS_IN_LINE).toMatch(/registers its business name, or trades under its owner’s own name/);
    expect(screen).toContain('{NO_LIMITS_LINE}');
    expect(screen).not.toMatch(/[Uu]nregistered|Self-declaration|capLine|tierLabel|How to lift the limits|Promoted placement/);
  });
  // [REVIEW-F S4-1] The line reads the own-name fact from the answer: the screen must hand it the whole answer.
  it('the screen passes the whole answer to the registration line', () => {
    expect(screen).toContain('{registrationLine(t)}');
  });
  it('the Account tab has no Seller status row', () => {
    expect(account).not.toMatch(/label="Seller status"/);
    expect(account).not.toMatch(/navigate\('VendorTier'\)/);
  });
});
