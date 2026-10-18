import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [R7 · GUARDRAILS §7(4) · owner 15 Oct 2026] The website says "verified",
// "licensed" and the like only where a person on our team checked a current
// document, and never "background-checked". The marketing pages say what a
// person actually did ("checked ... before they go live"), not a standing
// badge a lapsed document could make untrue.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('[R7] honest trust labels on the website', () => {
  it('the explore page, the store directory and the welcome page say what a person on our team checked', () => {
    expect(read('src/app/(app)/explore/page.tsx')).toContain("title: 'Checked before they go live', body: 'A person on our team checks every business’s and driver’s documents before they go live.'");
    const stores = read('src/app/(marketing)/stores/page.tsx');
    expect(stores).toContain('local businesses in Guyana, each checked by a person on our team before going live.');
    expect(stores).toContain('A person on our team checked every business here before it went live, and each keeps 100% of what you pay them.');
    expect(stores).not.toMatch(/across the Caribbean|delivered by Swift/);
    const welcome = read('src/app/(marketing)/welcome/page.tsx');
    expect(welcome).toContain("title: 'Checked partners, honest orders'");
    expect(welcome).toContain('Partners’ documents checked by a person on our team');
    expect(welcome).not.toMatch(/read off the policy|not ticked by an operator/);
  });

  it('no page says "document-verified", "ID-verified", "Verified locals", "background-checked", "vetted", "police-cleared" or "licensed (Certified)"', () => {
    const files = (function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
      }
      return out;
    })(join(process.cwd(), 'src'));
    const banned = /document-verified|\bID-verified\b|Verified locals|background[- ]check|\bvetted\b|police-cleared|licensed \(Certified\)/i;
    const hits = files.filter((f) => banned.test(strip(readFileSync(f, 'utf8'))));
    expect(hits.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});
