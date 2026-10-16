import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [Terms ¶11 · legal research A12 · GUARDRAILS §8] The app promises what the
// Terms say: "Swift charges Partners no commission on Orders". No forever
// promise ("no commission, ever"): fees change only with notice, and the
// website already says "No commission on orders" (#1786).
// ---------------------------------------------------------------------------

const src = join(__dirname, '..');
const read = (path: string) => readFileSync(join(src, path), 'utf8');

describe('partner copy: no commission on orders, never "ever"', () => {
  it('the onboarding price card and the mover earnings screen use the Terms wording', () => {
    const card = read('components/onboarding/PricingCard.tsx');
    expect(card).toContain("'Service provider rate · Keep 100% of every booking — no commission on orders.'");
    expect(card).toContain('`Keep 100% of every sale — no commission on orders.');
    expect(read('modules/mover/screens/EarningsScreen.tsx')).toContain('Swift only charges the flat weekly fee. No commission on orders.');
  });

  it('no app file makes the forever promise', () => {
    const files = (function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
      }
      return out;
    })(src);
    const hits = files.filter((f) => /commission,? ever|commission — ever/i.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(src, f))).toEqual([]);
  });
});
