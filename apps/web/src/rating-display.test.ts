import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [M-D6] The public star line has ONE source, and it is not the raw mean.
//
// `averageRating` is the legacy lifetime average. Its value for an actor nobody
// has rated is 5.0 — a schema default, not a measurement. The public storefront
// directory rendered it directly, so on the one page a stranger and Google see
// first:
//
//   21 vendors with ZERO ratings showed ★5.0 and sorted to the top
//   4 vendors with a single unhappy rating showed ★1.0
//   the vendor with 421 ratings sorted BELOW all 21
//
// The in-app web pages were worse in a quieter way: the API had already stopped
// sending `averageRating`, so `(v.averageRating ?? 0).toFixed(1)` type-checked
// against a stale interface and rendered ★0.0 for every vendor.
//
// `rating-surface.ts` on the API computes the honest line in one place —
// `displayRating` (null below the display floor, meaning "New"), `ratingBucket`,
// `topRated`. This gate keeps the web reading that and only that.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** A gate that matches its own explanation passes while the code it grades is
 *  gone. Strip prose before asserting, and prove the stripper still returned
 *  something. */
function stripComments(src: string): string {
  const out = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

/**
 * Surfaces that legitimately read the raw mean, with the reason.
 *
 * A vendor's OWN dashboard is not the public star line: it is the operator
 * looking at their own number, served by the vendor API, which this change did
 * not touch. It is listed rather than silently skipped so that the exemption is
 * a decision someone made, and so that this list can only shrink.
 */
const RAW_MEAN_ALLOWED = new Set([
  'app/dashboard/page.tsx',
]);

describe('the public star line comes from the rating mapper, never the raw mean [M-D6]', () => {
  it('no customer-facing file renders averageRating', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (RAW_MEAN_ALLOWED.has(rel)) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      if (src.length === 0) throw new Error(`stripComments emptied ${rel} — the stripper is broken, not the source`);
      if (/\baverageRating\b/.test(src)) offenders.push(rel);
    }
    expect(
      offenders.sort(),
      'these render the legacy lifetime mean, whose value for an unrated actor is 5.0. '
      + 'Use displayRating from the API (null ⇒ show "New"), or add a reasoned entry to RAW_MEAN_ALLOWED',
    ).toEqual([]);
  });

  it('the exemption list is audited from the other side — a stale entry fails', () => {
    // If a file stops rendering the raw mean, its exemption must go with it.
    // Otherwise the list grows into a place where real offenders can hide.
    const stale = [...RAW_MEAN_ALLOWED].filter((rel) => {
      const src = stripComments(readFileSync(path.join(SRC, rel), 'utf8'));
      return !/\baverageRating\b/.test(src);
    });
    expect(stale, 'exempted but no longer rendering averageRating — remove the exemption').toEqual([]);
  });

  it('every place that shows a star handles the null case', () => {
    // `displayRating` is null below the display floor. A file that renders it
    // with `.toFixed()` and no null branch prints "null" or throws — the two
    // ways this fix could be undone by someone being helpful.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (!/\bdisplayRating\b/.test(src)) continue;
      const rendersBare = /displayRating\.toFixed\(/.test(src);
      const hasNullBranch = /displayRating\s*===\s*null|displayRating\s*!==\s*null|displayRating\s*\?|displayRating\s*==\s*null/.test(src);
      if (rendersBare && !hasNullBranch) offenders.push(path.relative(SRC, file));
    }
    expect(offenders.sort(), 'renders displayRating without handling null — below the floor it is null, not a number').toEqual([]);
  });
});
