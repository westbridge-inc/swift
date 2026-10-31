import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdHoursText, mmgHoldSentence } from './mmgHold';

// [owner 30 Oct 2026] A store's first-ever MMG number goes live after 1 hour (a pay link always keeps the cool-off); a change, or one
// added again after removal, keeps the cool-off. The words before saving name the server's hours, never a guess.

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('the hold sentence before saving an MMG number or link', () => {
  it('a first number: "goes live in about 1 hour", no MMG until then (there is no current number)', () => {
    expect(mmgHoldSentence('number', 1, false)).toBe('We’ll text you a code first. Your number goes live in about 1 hour; until then customers can’t choose MMG for your store.');
  });

  it('a change of a live number: the server\'s 24 hours, and the current number keeps working', () => {
    expect(mmgHoldSentence('number', 24, true)).toBe('We’ll text you a code first. The new number goes live in about 24 hours — your current number keeps working until then.');
  });

  it('a number added again after removal: the server says 24, and the words say 24 (not 1)', () => {
    expect(mmgHoldSentence('number', 24, false)).toBe('We’ll text you a code first. Your number goes live in about 24 hours; until then customers can’t choose MMG for your store.');
  });

  it('the link reads the same way (the hours are whatever the server sends)', () => {
    expect(mmgHoldSentence('link', 1, false)).toBe('We’ll text you a code first. Your link goes live in about 1 hour; until then nobody can pay you through it.');
    expect(mmgHoldSentence('link', 24, true)).toBe('We’ll text you a code first. The new link goes live in about 24 hours — your current link keeps working until then.');
  });

  it('an older server that sends no hours: no number of hours is promised', () => {
    expect(mmgHoldSentence('number', null, true)).toBe('We’ll text you a code first. The new number goes live after a hold — your current number keeps working until then, and we’ll show you exactly when.');
    expect(mmgHoldSentence('number', undefined, false)).toBe('We’ll text you a code first. Your number goes live after a hold, and we’ll show you exactly when.');
    expect(mmgHoldSentence('number', 0, false)).not.toMatch(/\d/);
    expect(holdHoursText(1)).toBe('1 hour');
    expect(holdHoursText(72)).toBe('72 hours');
  });

  it('the cards say it from the server\'s hours, and the screens pass them', () => {
    expect(src('src/components/MmgNumberCard.tsx')).toContain("{mmgHoldSentence('number', holdHours, !!value)}");
    expect(src('src/components/MmgPayLinkCard.tsx')).toContain("{mmgHoldSentence('link', holdHours, !!value)}");
    expect(src('src/modules/vendor/screens/VendorAccountScreen.tsx')).toContain('holdHours={store?.mmgNumberHoldHours ?? null}');
    expect(src('src/modules/vendor/screens/VendorAccountScreen.tsx')).toContain('holdHours={store?.mmgPayUrlHoldHours ?? null}');
    expect(src('src/modules/mover/screens/MoverAccountScreen.tsx')).toContain('holdHours={profile?.mmgPayUrlHoldHours ?? null}');
  });
});
