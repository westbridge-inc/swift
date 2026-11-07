import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [REVIEW-F #2281 S2-1] `next build` refuses a page.tsx that exports anything but its page and Next's own names
// ("PROMO_WORDS is not a valid Page export field"). tsc and vitest cannot see it, so the build failed only in CI. This
// reads every page file and names what it exports: a page's words or helpers belong in a sibling module
// (inventory/vat-class-words.ts, promotions/promo-words.ts).
// ---------------------------------------------------------------------------

const APP = join(process.cwd(), 'src', 'app');
const ALLOWED = new Set([
  'default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', 'generateStaticParams', 'dynamic',
  'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration', 'experimental_ppr',
]);

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, out);
    else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) out.push(path);
  }
  return out;
}

function pageExports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]!);
  if (/^export\s+default\b/m.test(source)) names.push('default');
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(',').map((p) => p.trim()).filter(Boolean)) names.push(part.split(/\s+as\s+/).pop()!.trim());
  }
  return names;
}

describe('[REVIEW-F #2281 S2-1] every page file exports only what Next accepts', () => {
  it('the reader sees a word export, a renamed default and Next\'s names', () => {
    expect(pageExports("export const WORDS = {};\nexport default function P() {}\nexport const metadata = {};")).toEqual(['WORDS', 'metadata', 'default']);
    expect(pageExports("export {\n  a as generateMetadata,\n  B as default,\n} from 'x';")).toEqual(['generateMetadata', 'default']);
  });

  it('no page.tsx exports anything else', () => {
    const bad = pages(APP).flatMap((file) =>
      pageExports(readFileSync(file, 'utf8')).filter((name) => !ALLOWED.has(name)).map((name) => `${relative(APP, file)}: ${name}`));
    expect(bad).toEqual([]);
  });
});
