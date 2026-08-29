import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A SEEDER WITH NO CALLER IS AN ENDPOINT WITH NO CALLER, ONE LAYER DOWN.
 *
 * `seedDiscoveryTaxonomy` shipped complete: 14 RETAIL categories, an alias
 * dictionary described in its own source as "the local moat", create-only
 * name/emoji so a founder's edits win forever, aliases UNION on re-seed. It was
 * imported by exactly two files — both tests.
 *
 * So the taxonomy existed in the repository and in no database. Every
 * deployment had zero categories. The category rail had nothing to render, the
 * classifier had nothing to classify into, and the market feed — however
 * correct its query — could only ever return an empty grid. Nothing failed:
 * the flag defaults off, an empty rail is a legitimate state, and an empty
 * category reads as "no stock yet".
 *
 * Measured after wiring it: 0 rows → 42 (14 RETAIL).
 *
 * This gate makes the class visible rather than the instance. Every `*.seed.ts`
 * must be reachable from something that is not a test — or be listed below with
 * a reason a reviewer can check.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const all = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);
const isTest = (f: string) => rel(f).includes('__tests__') || /\.test\.ts$/.test(f);

/** Seeders deliberately reachable only from tests or tooling, each with a reason. */
const TEST_ONLY_SEEDERS: Array<{ file: string; why: string }> = [];

describe('every seeder is reachable from production code', () => {
  const seeders = all.filter((f) => /\.seed\.ts$/.test(f)).map(rel);

  it('finds the seed modules at all (guards the guard)', () => {
    // If the glob broke, the assertion below would pass against nothing.
    expect(seeders.length, 'no *.seed.ts found — the scan is wrong, not the tree').toBeGreaterThanOrEqual(3);
  });

  it.each([
    'modules/discovery/taxonomy.seed',
    'modules/rating/tag-taxonomy.seed',
    'modules/ads/placement.seed',
  ])('%s is imported by something that is not a test', (mod) => {
    const exempt = new Set(TEST_ONLY_SEEDERS.map((s) => s.file));
    if (exempt.has(mod)) return;

    const base = mod.split('/').pop()!;
    const callers = all
      .filter((f) => !isTest(f))
      .filter((f) => !f.endsWith(`${base}.ts`)) // not itself
      // BOTH import forms. The first version of this only matched static
      // `from '…'` and flagged the ads seeder, which is reached by a dynamic
      // `await import('…')` from an admin route — a false positive in the gate
      // itself. My own discovery seeder is dynamically imported too, so the
      // narrow regex would have missed the very thing this file was written for.
      .filter((f) => new RegExp(`(from|import\\()\\s*'[^']*${base}'`).test(readFileSync(f, 'utf8')))
      .map(rel);

    expect(
      callers,
      `${mod} is only reachable from tests — it exists in the repo and in no database`,
    ).not.toEqual([]);
  });

  it('the discovery taxonomy is planted at BOOT, not on a request path', () => {
    // It must not seed lazily inside a GET: that turns a read into a write, and
    // the rail is served to unauthenticated shoppers. Boot, after listen, so it
    // can never delay the port opening either.
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    expect(server).toMatch(/seedDiscoveryTaxonomy/);
    const afterListen = server.split('app.listen(')[1] ?? '';
    // The CALL, not a mention. An import with no invocation is precisely the
    // state this file exists to end, and matching the bare name passes on it.
    expect(afterListen, 'seed AFTER listen — startup must never block on it')
      .toMatch(/await seedDiscoveryTaxonomy\(/);
  });

  it('a failed seed is logged, never fatal', () => {
    // A missing taxonomy degrades the rail. It must not take the API down —
    // the same rule the Meilisearch warm-up follows.
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    // Scoped to the seed's OWN block. Split on the CALL (the first mention is
    // the comment explaining it) and stop at the IIFE's close — a wider window
    // runs into `start()`'s catch, where `process.exit(1)` is the correct
    // behaviour for a server that could not boot at all.
    const after = server.split('await seedDiscoveryTaxonomy(')[1] ?? '';
    const block = after.split('})();')[0] ?? '';
    expect(block, 'the seed must catch its own failure').toMatch(/catch/);
    expect(block, 'a seed failure must not exit the process').not.toMatch(/process\.exit/);
  });
});
