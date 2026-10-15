import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRICE_PROMISE_BODY, PRICE_PROMISE_TITLE } from './price-promise';

// ---------------------------------------------------------------------------
// [Legal research A12 · CAA s.31, s.33(1)(b)(i)] "0% fees, no markups" sat next to a delivery fee, and partners
// pay a weekly fee: a price claim a court could read as misleading. The research's line replaces it on the
// home page and on Explore. Partner lines ("no commission", "keep 100%") are true and stay.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('the customer price promise is the research’s line', () => {
  it('says no commission and no markup, the delivery fee shown first, and pickup free', () => {
    expect(`${PRICE_PROMISE_TITLE} ${PRICE_PROMISE_BODY}`).toBe('No commission and no markup on store prices. The delivery fee is shown before you order; pickup is free.');
  });

  it('home and Explore show it, from the one module', () => {
    expect(read('components', 'customer-home.tsx')).toMatch(/\{PRICE_PROMISE_TITLE\}[\s\S]*\{PRICE_PROMISE_BODY\}/);
    expect(read('app', '(app)', 'explore', 'page.tsx')).toMatch(/title: PRICE_PROMISE_TITLE, body: PRICE_PROMISE_BODY/);
  });

  it('no website source says "0% fees" or "no fees" to a customer', () => {
    const hits: string[] = [];
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'legal') walk(p); continue; }
        if (!/\.(tsx?|jsx?)$/.test(name) || /\.test\./.test(name)) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/0% fees?|\bno fees\b/i.test(line) && !/^\s*(\/\/|\*|\{?\/\*)/.test(line)) hits.push(`${relative(SRC, p)}:${i + 1}`);
        });
      }
    })(SRC);
    expect(hits).toEqual([]);
  });
});
