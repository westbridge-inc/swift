import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [FOOD-PERMIT · owner ruling 24 Oct 2026] The business FAQ says truly what a restaurant gives: its GRA licence, and a
// tick that everyone who handles its food holds a current food handler's certificate. A restaurant no longer uploads a
// "food handler's permit". [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (a), a DELIBERATE change] There is no seller
// without a business registration any more: a store registers its business name or, when its name is its owner's own
// name, signs the own-name declaration. [(d)] The licence carries the GRA's own name.
const FAQ = readFileSync(join(process.cwd(), 'src/app/(marketing)/faq/page.tsx'), 'utf8').replace(/\s+/g, ' ');

describe('[FOOD-PERMIT · CHECKLIST-LEGAL] the business FAQ', () => {
  it('no longer says a restaurant adds a food handler’s permit', () => {
    expect(FAQ).not.toMatch(/restaurant adds its GRA licence and food handler&apos;s permit/);
  });

  it('says the restaurant confirms its food handlers, under the GRA Food Restaurant Licence', () => {
    expect(FAQ).toContain('a restaurant adds its GRA Food Restaurant Licence and confirms that everyone who handles its food holds a current food handler&apos;s certificate');
  });

  it('offers no way in without a registration: a registered business name, or the own-name declaration', () => {
    expect(FAQ).not.toMatch(/without a registered business/);
    expect(FAQ).toContain('a business registration (or, if your store&apos;s name is your own name, a short signed declaration instead)');
  });
});
