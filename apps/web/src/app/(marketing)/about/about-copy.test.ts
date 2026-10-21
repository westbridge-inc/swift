import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [SWITCHES fact-check, 21 Oct] Ads are OFF at launch (GUARDRAILS §4: a page never offers a feature
// that is switched off). The About page offered businesses advertising "under separate advertising
// terms", terms that do not exist, for a product nobody can buy.
const PAGE = readFileSync(join(__dirname, 'page.tsx'), 'utf8');

describe('the About page offers only what Swift sells today', () => {
  it('says nothing about buying advertising while ads are off', () => {
    expect(PAGE).not.toMatch(/advertis/i);
  });

  it('still says the subscription is the whole business model, with no commission', () => {
    expect(PAGE).toMatch(/the subscription is the entire\s+business model/);
    expect(PAGE).toMatch(/There is no commission on any sale, fare or tip/);
  });
});
