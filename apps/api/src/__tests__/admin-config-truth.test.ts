import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Every key the admin config page renders MUST be read by production code.
//
// The page once showed 21 editable fields of which exactly one was read —
// the other 20 saved successfully and changed nothing, and one of them
// disagreed with the shipped constant while looking authoritative. This test
// makes that class of defect impossible to reintroduce: add a key to the page
// without a reader in the API and this fails, naming the key.
//
// "Reader" = the quoted key literal appears in comment-stripped API source
// outside tests, the seed, and the generic admin CRUD (which reads every key
// and therefore proves nothing about any particular one).
// ---------------------------------------------------------------------------

const PAGE = join(process.cwd(), '../admin/src/app/config/page.tsx');
const API_SRC = join(process.cwd(), 'src');
const SEED_DIR = join(process.cwd(), 'prisma');

/** Strip block and line comments. Paired with non-empty assertions below so a
 *  broken stripper can never turn these checks vacuous (the hazard-matching
 *  rule: prove the stripper returned something before trusting its output). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function pageKeys(): string[] {
  const raw = readFileSync(PAGE, 'utf8');
  const code = stripComments(raw);
  expect(code.length, 'comment stripper emptied the page — the scan below would be vacuous').toBeGreaterThan(500);
  const keys = [...code.matchAll(/key: '([a-z0-9_.]+)'/g)].map((m) => m[1]!);
  return [...new Set(keys)];
}

describe('admin config page — every rendered key has a real reader', () => {
  it('the page still renders at least one editable key (the scan is not vacuous)', () => {
    expect(pageKeys().length).toBeGreaterThanOrEqual(1);
  });

  it('every key on the page is read by production code', () => {
    const readers = tsFiles(API_SRC).filter(
      // The generic config CRUD reads *every* key, so it cannot vouch for one.
      (f) => !f.endsWith('modules/admin/admin.routes.ts'),
    );
    const sources = readers.map((f) => stripComments(readFileSync(f, 'utf8')));
    expect(
      sources.reduce((n, s) => n + s.length, 0),
      'comment stripper emptied the API source — the scan would be vacuous',
    ).toBeGreaterThan(100_000);

    const unread = pageKeys().filter((key) => !sources.some((s) => s.includes(`'${key}'`)));
    expect(
      unread,
      `these page keys are read by NOTHING in apps/api/src — wire each (see response-sla.ts) or remove it from the page: ${unread.join(', ')}`,
    ).toEqual([]);
  });

  it('the seed plants no dead keys beyond the documented test fixture', () => {
    const seed = stripComments(readFileSync(join(SEED_DIR, 'seed-platform.ts'), 'utf8'));
    expect(seed.length, 'stripper emptied the seed').toBeGreaterThan(1_000);
    const seeded = [...seed.matchAll(/key: '([a-z0-9_.]+)'/g)].map((m) => m[1]!);
    expect(seeded.length).toBeGreaterThanOrEqual(1);

    const readers = tsFiles(API_SRC)
      .filter((f) => !f.endsWith('modules/admin/admin.routes.ts'))
      .map((f) => stripComments(readFileSync(f, 'utf8')));
    // delivery_base_fee is the admin-audit test's write fixture — allowed, documented in the seed.
    const allowed = new Set(['delivery_base_fee']);
    const dead = [...new Set(seeded)].filter(
      (key) => !allowed.has(key) && !readers.some((s) => s.includes(`'${key}'`)),
    );
    expect(dead, `seeded but read by nothing: ${dead.join(', ')}`).toEqual([]);
  });
});
