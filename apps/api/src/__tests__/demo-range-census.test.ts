import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// [PLAT-3] The demo phone range (+592600…) is a live carrier range, so no code
// outside the tests may SELECT people by it: not the demo purge, not the
// production census, not the demo seed's own backfills. Synthetic rows are
// found by their marker (syntheticRunId). Tests keep their own fixture ranges
// on test databases and are not scanned.

const API = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(API, '..', '..');
const ROOTS = [path.join(API, 'src'), path.join(API, 'prisma'), path.join(REPO, 'scripts')];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist' || entry === 'migrations') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|mts|js|mjs)$/.test(full) && !/\.test\.[mc]?[jt]s$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// A query predicate on the range: Prisma `startsWith`, or SQL LIKE / ~ on it.
const RANGE_SELECTOR = /startsWith:\s*(?:DEMO_PHONE_PREFIX|['"`]\+?592600)|(?:LIKE|ILIKE|~)\s*['"`]\^?\\?\+?592600/;

describe('[PLAT-3] nothing selects people by the demo phone range', () => {
  const files = ROOTS.flatMap((root) => sources(root));

  it('scans the API source, the seeds and the scripts', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('prisma', 'seed.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('ops', 'purge-plan.ts')))).toBe(true);
  });

  it('no query predicate on +592600 outside the tests', () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (RANGE_SELECTOR.test(line)) offenders.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, `selections by the demo phone range:\n${offenders.join('\n')}`).toEqual([]);
  });
});
