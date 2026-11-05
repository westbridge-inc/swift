import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [OWNER 5 Nov 2026] The public FAQ says the two ways to pay the weekly fee, and the one way never to.
describe('the FAQ on paying the weekly fee', () => {
  const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8').replace(/\s+/g, ' ');
  it('names MMG checkout and paying Westbridge Inc. in person', () => {
    expect(page).toContain("How do businesses, riders and drivers pay the weekly fee?");
    expect(page).toContain("MMG&apos;s checkout page");
    expect(page).toContain('directly to Westbridge Inc., by cash, cheque or bank transfer');
  });
  it('says a cheque counts once cleared, and never an agent', () => {
    expect(page).toContain('A cheque counts once it clears');
    expect(page).toContain('Never pay through an agent or anyone else');
  });
});
