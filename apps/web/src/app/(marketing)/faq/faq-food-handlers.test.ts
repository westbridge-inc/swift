import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [FOOD-PERMIT · owner ruling 24 Oct 2026] The business FAQ says truly what a restaurant gives: its GRA licence, and a
// tick that everyone who handles its food holds a current food handler's certificate. A registered restaurant no
// longer uploads a "food handler's permit"; a cook selling without a registered business still uploads their own
// certificate.
const FAQ = readFileSync(join(process.cwd(), 'src/app/(marketing)/faq/page.tsx'), 'utf8').replace(/\s+/g, ' ');

describe('[FOOD-PERMIT] the business FAQ', () => {
  it('no longer says a restaurant adds a food handler’s permit', () => {
    expect(FAQ).not.toMatch(/restaurant adds its GRA licence and food handler&apos;s permit/);
  });

  it('says the restaurant confirms its food handlers, and who still uploads a certificate', () => {
    expect(FAQ).toContain('a restaurant adds its GRA licence and confirms that everyone who handles its food holds a current food handler&apos;s certificate');
    expect(FAQ).toContain('a cook selling without a registered business uploads their own food handler&apos;s certificate');
  });
});
