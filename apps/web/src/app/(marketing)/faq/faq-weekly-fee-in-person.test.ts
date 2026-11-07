import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { site } from '@/site.config';

// [OWNER 5 Nov 2026] The public FAQ says the two ways to pay the weekly fee, and the one way never to.
describe('the FAQ on paying the weekly fee', () => {
  const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8').replace(/\s+/g, ' ');
  it('names MMG checkout and paying Westbridge Inc. in person', () => {
    expect(page).toContain("How do businesses, riders and drivers pay the weekly fee?");
    expect(page).toContain("MMG&apos;s checkout page");
    // The name comes from site config (company-facts guard), which must still say Westbridge Inc.
    expect(page).toContain('directly to {site.legalEntityName}, by cash, cheque or bank transfer');
    expect(site.legalEntityName).toBe('Westbridge Inc.');
    expect(page).toContain('href="/contact"');
  });
  it('says a cheque counts once cleared, a payment once recorded, and to give it to nobody else', () => {
    expect(page).toContain('A cheque counts once it clears');
    expect(page).toContain('a payment counts once Swift records it');
    expect(page).toContain('Never give it to anyone else');
  });
});
