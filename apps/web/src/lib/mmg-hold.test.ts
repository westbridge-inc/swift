import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdHoursText, payLinkHoldLine } from './mmg-hold';

// [owner 30 Oct 2026] A store's first-ever MMG NUMBER goes live after 1 hour; a pay link always keeps the cool-off.
// The words only render the server's hours, whatever they are. The confirm before saving names the server's hours, never a guess.

describe('the pay link hold line before saving', () => {
  it('no live link: the server\'s hours, and nobody can pay through it until then', () => {
    expect(payLinkHoldLine(1, null)).toBe('It goes live in about 1 hour. Until then nobody can pay you through it.');
  });
  it('a change: the server\'s 24 hours, and the live link keeps taking payments', () => {
    expect(payLinkHoldLine(24, 'https://pay.mmg.gy/a')).toBe('This replaces https://pay.mmg.gy/a in about 24 hours. Until then every payment still goes to it.');
  });
  it('added again after removal: the server says 24 and so do the words', () => {
    expect(payLinkHoldLine(24, null)).toBe('It goes live in about 24 hours. Until then nobody can pay you through it.');
  });
  it('an older server with no hours: the old words, no number of hours', () => {
    expect(payLinkHoldLine(undefined, null)).toBe('This replaces no current link after a short safety delay.');
    expect(payLinkHoldLine(null, 'https://pay.mmg.gy/a')).toBe('This replaces https://pay.mmg.gy/a after a short safety delay.');
    expect(holdHoursText(1)).toBe('1 hour');
  });
  it('the portal account page uses the server\'s hours', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/portal/account/page.tsx'), 'utf8');
    expect(page).toContain("payLinkHoldLine(driver.data?.['mmgPayUrlHoldHours'], liveUrl)");
    expect(page).not.toContain('after a short safety delay.`');
  });
});
