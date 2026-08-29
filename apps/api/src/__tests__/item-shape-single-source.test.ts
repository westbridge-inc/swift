import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ITEM_HIT_SELECT,
  NEW_ITEM_WINDOW_DAYS,
  itemHitFromSearchDoc,
  toItemHit,
  toItemSearchDoc,
} from '../modules/search/item-hit';

/**
 * ONE SHAPE FOR AN ITEM OUTSIDE ITS STORE — the gate for a claim that was
 * false when it was written.
 *
 * `item-hit.ts` was created for the Market feed carrying this comment:
 *
 *     "Search returns it, and the Market feed returns it. Extracted here so
 *      there is exactly one definition."
 *
 * Search did not return it. `search.routes.ts` kept its own local `type
 * ItemHit` and built the object by hand on BOTH engine paths, and
 * `search.service.ts` built the index document by hand in BOTH syncs. Four
 * hand-written copies of one shape, sitting under a comment that said there was
 * one. That is worse than four copies with no comment, because the comment is
 * what a later reader trusts instead of checking.
 *
 * Extraction is not consolidation. The originals have to actually go. This file
 * is what makes that permanent — a doc-comment cannot fail CI, and an assertion
 * can.
 *
 * THE HAZARD IT GUARDS: two surfaces show the same item. Search says a hammer
 * is not new; the Market card says it is. Nobody can tell which is right,
 * because the two were computed by different code from different fields — and
 * the bug reads as flakiness rather than as drift.
 */

const API = join(__dirname, '..');
const read = (p: string) => readFileSync(join(API, p), 'utf8');

/** Comments describe the hazard; only CODE can commit it. Assertions about
 *  banned patterns run against source with comments removed, or this file's own
 *  prose would trip its own gates. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const ROUTES = 'modules/search/search.routes.ts';
const SERVICE = 'modules/search/search.service.ts';
const MARKET = 'modules/market/market.routes.ts';

describe('the wire shape has one definition', () => {
  it('search does not declare its own ItemHit', () => {
    expect(
      code(ROUTES),
      'a local `type ItemHit` in the search route is the fork this file exists to stop',
    ).not.toMatch(/type\s+ItemHit\s*=/);
  });

  it('guards the guard — the gate above can still see a declaration', () => {
    // If the strip-comments helper ever ate real code, every "not.toMatch"
    // in this file would pass vacuously and the gate would be decoration.
    expect(code('modules/search/item-hit.ts')).toMatch(/type\s+ItemHit\s*=/);
  });

  it('both engine paths and the market feed import it', () => {
    for (const file of [ROUTES, MARKET]) {
      expect(code(file), `${file} must import the shared shape`).toMatch(
        /from '\.\.?\/(search\/)?item-hit'/,
      );
    }
  });

  it('neither engine path hand-assembles an item', () => {
    // `vendorName:` appearing in an object literal in the route means someone
    // is shaping an item there again. The mappers own that field.
    const src = code(ROUTES);
    expect(src.match(/vendorName:/g) ?? [], 'the route shapes no items itself').toHaveLength(0);
  });
});

describe('the index document has one builder', () => {
  it('both syncs go through it', () => {
    const src = code(SERVICE);
    expect(
      (src.match(/toItemSearchDoc\(/g) ?? []).length,
      'syncAllItems and syncVendorItems — a field indexed by one and missed by the other makes an item change shape depending on which job last ran',
    ).toBe(2);
  });

  it('no sync still writes the document inline', () => {
    // `dietaryTags` + `allergens` together only ever appear in the item index
    // document; finding them in the service means a literal survived.
    const src = code(SERVICE);
    expect(src, 'an inline index document is the copy this replaced').not.toMatch(/allergens:\s*i\./);
  });
});

describe('the shapes actually agree, not just structurally', () => {
  const row = {
    id: 'i1',
    name: 'Claw Hammer',
    description: 'Steel',
    basePrice: 2500,
    imageUrl: null,
    createdAt: new Date(),
    vendorId: 'v1',
    vendor: { name: 'City Hardware' },
    category: { name: 'Power Tools' },
    isAvailable: true,
    isPopular: false,
    dietaryTags: [],
    allergens: [],
    totalOrdered: 0,
  };

  it('a DB row and its own index document produce the SAME hit', () => {
    // The real drift test: take one item, put it through the slow path and
    // through the fast path, and demand the client cannot tell them apart.
    // This is the "ONE wire contract whichever engine answered" rule, executed.
    const fromDb = toItemHit(row);
    const fromIndex = itemHitFromSearchDoc(toItemSearchDoc(row, ['hardware-tools']) as never);
    expect(fromIndex).toEqual(fromDb);
  });

  it('an item too old for the badge is not new on either path', () => {
    const old = { ...row, createdAt: new Date(Date.now() - (NEW_ITEM_WINDOW_DAYS + 5) * 86_400_000) };
    expect(toItemHit(old).isNew).toBe(false);
    expect(itemHitFromSearchDoc(toItemSearchDoc(old, []) as never).isNew).toBe(false);
  });

  it('a document indexed before `createdAt` existed answers `false`, never a guess', () => {
    // Degraded data may only make a surface MORE conservative [L6]. A missing
    // timestamp means no badge; it must never mean "assume fresh".
    const legacy = { id: 'x', name: 'Old doc', basePrice: 10, vendorId: 'v', vendorName: 'S' };
    expect(itemHitFromSearchDoc(legacy).isNew).toBe(false);
  });

  it('the select carries every field the mapper reads', () => {
    // A mapper reading a field the select never asked for is `undefined` at
    // runtime and green at compile time — `createdAt` was exactly that risk.
    for (const field of ['id', 'name', 'basePrice', 'imageUrl', 'createdAt', 'vendorId']) {
      expect(ITEM_HIT_SELECT, `${field} is read by toItemHit`).toHaveProperty(field);
    }
  });
});
