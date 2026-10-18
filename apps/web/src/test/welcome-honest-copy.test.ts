import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [Legal research A12 · Terms ¶11 · GUARDRAILS §8] The welcome page promises
// only what the Terms say: a flat weekly fee and no commission on orders. No
// "ever", no "no introductory rate that expires" (new partners start on a free
// trial, and a fee change is announced first).
// [#1754 · Terms ¶9(h)] Parcels carry goods only: letters, documents and mail
// are refused, so a parcel is never "anything".
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('welcome page: honest fee and parcel words', () => {
  it('says "no commission on orders" without a forever promise or an introductory-rate claim', () => {
    const welcome = strip(read('src/app/(marketing)/welcome/page.tsx'));
    expect(welcome).toContain("title: 'No commission on orders'");
    expect(welcome).toContain('keep 100% of every sale, fare and tip. Swift takes no percentage.');
    expect(welcome).not.toMatch(/introductory rate|commission,? ever|commission — ever|no hidden cut/i);
    expect(strip(read('src/app/layout.tsx'))).not.toMatch(/commission,? ever|commission — ever/i);
  });

  it('describes parcels as goods, never "anything", and names what is refused', () => {
    const welcome = strip(read('src/app/(marketing)/welcome/page.tsx'));
    expect(welcome).toContain("label: 'Parcels', blurb: 'Goods across town, never letters or mail'");
    expect(welcome).not.toMatch(/Anything, across town/);
  });
});
