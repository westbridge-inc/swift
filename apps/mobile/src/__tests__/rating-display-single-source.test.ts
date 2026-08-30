import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * ONE DEFINITION OF WHAT A RATING LOOKS LIKE. (ALG-31 · law L2 · `ci_one_definition`)
 *
 * `rating-surface.ts` is THE mapper, and it is RUNNING-PROVEN: it returns
 * `displayRating: null` below `RATING_MIN_DISPLAY` (5) so a subject with too
 * few ratings reads "New" instead of a number computed from almost nothing.
 *
 * Two customer-facing surfaces bypassed it, each in its own way:
 *
 *   MarketScreen    rendered `v.averageRating` — the RAW LIFETIME MEAN. City
 *                   Hardware has exactly ONE rating, of 1, so the front page of
 *                   the Market tab showed ★1.0. Measured on the live database:
 *                   averageRating=1, totalRatings=1, RATING_MIN_DISPLAY=5.
 *
 *   ServicesScreen  rendered the raw mean behind a hand-rolled
 *                   `totalRatings > 0` gate — a THIRD definition of the same
 *                   rule, and a far looser one. One 1-star rating branded a
 *                   tradesperson ★1.0 on the browse page.
 *
 * The second is the more instructive failure: the services API never called
 * `ratingSurfaces` at all, so the client had no honest field to render and
 * invented a threshold. **A missing server field is how a client grows a second
 * definition.** The fix was both halves.
 *
 * This also protects something the algorithm work depends on: ALG-39 ranks on
 * `displayRating` with "null treated as neutral, never as zero — this is what
 * protects new vendors", and ALG-43's cold-start boost is explicitly told not to
 * stack a second protection on top of it. A surface that renders the raw mean
 * quietly removes the first one.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — the standing hazard-matching rule. The
 *  comments in these files necessarily name the very field being banned. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

const files = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);

/**
 * Surfaces that legitimately show a RAW mean, each with a written reason.
 * Audited from both sides below so an entry cannot outlive its justification.
 */
const RAW_MEAN_ALLOWED: Array<{ file: string; why: string }> = [
  {
    file: 'modules/vendor/screens/VendorInsightsScreen.tsx',
    why: "a vendor's OWN reviews summary on their own dashboard — their true lifetime average is theirs to see, and it is not a public star line on anyone's card",
  },
  {
    file: 'modules/mover/screens/MoverAccountScreen.tsx',
    why: "a mover's OWN account screen; the public-facing standing beside it already renders through the mapper via StandingCard",
  },
];

describe('no customer-facing card renders a raw lifetime mean', () => {
  const exempt = new Set(RAW_MEAN_ALLOWED.map((r) => r.file));

  it('nothing passes averageRating into a rating prop', () => {
    // The exact shape that shipped: `rating={... averageRating ...}`.
    const offenders = files
      .filter((f) => !exempt.has(rel(f)))
      .filter((f) => /rating=\{[^}]*averageRating/.test(code(f)))
      .map(rel);

    expect(
      offenders,
      'Render `displayRating` from rating-surface.ts. The raw mean shows ★1.0 for a subject ' +
        'with a single rating, which is what RATING_MIN_DISPLAY exists to prevent.',
    ).toEqual([]);
  });

  it('nothing hand-rolls its own "enough ratings" threshold on the STAR', () => {
    // ServicesScreen had `rating={p.totalRatings > 0 ? averageRating : null}`.
    //
    // Scoped to the `rating=` prop deliberately. Gating the COUNT text on
    // `totalRatings > 0` — "3 ratings", shown only when there are some — is
    // honest and stays legal; the first version of this assertion flagged that
    // too and was wrong. The hazard is a threshold deciding whether a STAR
    // appears, because that is the rule RATING_MIN_DISPLAY already owns.
    const offenders = files
      .filter((f) => !exempt.has(rel(f)))
      .filter((f) => /rating=\{[^}]*totalRatings\s*[><]=?\s*\d/.test(code(f)))
      .map(rel);

    expect(
      offenders,
      'RATING_MIN_DISPLAY lives in rating-math.ts and is applied by rating-surface.ts. ' +
        'A star threshold in a screen is a second definition that will drift.',
    ).toEqual([]);
  });

  it('the scan can see both shapes (guards the guard)', () => {
    // If these regexes could not match what actually shipped, the assertions
    // above would pass against anything. These are the literal shipped strings.
    expect(/rating=\{[^}]*averageRating/.test('rating={v.averageRating ?? null}')).toBe(true);
    expect(
      /rating=\{[^}]*totalRatings\s*[><]=?\s*\d/.test('rating={p.totalRatings > 0 ? Number(p.averageRating) : null}'),
    ).toBe(true);
    // ...and must NOT fire on the legitimate count line.
    expect(
      /rating=\{[^}]*totalRatings\s*[><]=?\s*\d/.test('extra={p.totalRatings > 0 ? `${p.totalRatings} ratings` : undefined}'),
    ).toBe(false);
  });

  it('the fixed surface still reads displayRating', () => {
    // Named so the fix cannot be quietly reverted to the raw field.
    const src = code(join(SRC, 'modules/services/screens/ServicesScreen.tsx'));
    expect(src, 'ServicesScreen must render displayRating').toMatch(/rating=\{[^}]*displayRating/);
  });

  it('MarketScreen renders NO rating at all — and that is the correct answer', () => {
    // It used to list SHOPS, so it showed a vendor's stars (and briefly the raw
    // mean, which is why this file exists). It now lists ITEMS [MKT G2], and
    // `Item` has no rating: a per-item star is a founder decision (M-D2), and
    // putting the SELLER's stars on a PRODUCT card is a different claim than
    // the one the number supports.
    //
    // So the honest state is no star — and the guard has to say that
    // explicitly, or the next person "restores" the rating this screen
    // deliberately dropped.
    const src = code(join(SRC, 'modules/shop/screens/MarketScreen.tsx'));
    expect(src, 'no star belongs on a product card until Item carries a rating').not.toMatch(/rating=\{/);
    expect(src, 'and certainly not a raw mean').not.toMatch(/averageRating/);
  });
});

describe('the raw-mean exemptions are audited from both sides', () => {
  it('every exempt file still exists', () => {
    for (const { file } of RAW_MEAN_ALLOWED) {
      expect(files.map(rel), `${file} is exempt but no longer exists`).toContain(file);
    }
  });

  it('every exemption carries a written reason', () => {
    for (const { file, why } of RAW_MEAN_ALLOWED) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('an exemption that no longer uses a raw mean must be removed', () => {
    for (const { file } of RAW_MEAN_ALLOWED) {
      expect(
        /averageRating/.test(code(join(SRC, file))),
        `${file} no longer references averageRating — delete its exemption`,
      ).toBe(true);
    }
  });
});
