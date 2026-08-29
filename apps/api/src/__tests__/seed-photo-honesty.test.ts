import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * NO STOCK PHOTOGRAPH MAY STAND IN FOR MERCHANDISE — THE DATA SIDE OF IT.
 *
 * The mobile app already has this gate (`stock-photo-gate.test.ts`), and it
 * scans the mobile source tree. But the app was never where the violation
 * lived: the client renders `Item.imageUrl` faithfully, and the wrong picture
 * is put there by `prisma/seed.ts`. The law was enforced on one side of the
 * wire and the data walked in on the other.
 *
 * F-264 found nine restaurant dishes wearing the wrong photograph — Mauby, a
 * Guyanese bark-brewed drink, was a cheeseburger — by downloading every seeded
 * photo and looking at it. It fixed them in two places, and the two-place fix
 * is the part worth keeping: deleting a bad URL from the map does NOT fix the
 * dev databases that already hold it, so the name is ALSO nulled on every
 * re-seed.
 *
 * That pass covered FOOD. The retail shelf was checked later, by the same
 * method, and three of five hardware photos misrepresented the goods on the
 * exact attribute their item name promises — a 6-piece screwdriver set shown as
 * one screwdriver, WHITE paint shown as blue, an LED bulb shown as a lit
 * incandescent filament. They now travel in the nulling list too.
 *
 * What this file gates is the SHAPE of that fix, because the shape is what a
 * later contributor gets wrong: a name in both structures means the seed sets
 * a photo and then removes it, which reads as a bug rather than as a decision.
 */

const SEED = readFileSync(join(__dirname, '../../prisma/seed.ts'), 'utf8');

/** The item→photo map, as names. */
const mapNames = (() => {
  const block = SEED.match(/const itemImages[^{]*\{([\s\S]*?)\n {2}\};/);
  if (!block) throw new Error('itemImages map not found — this gate is reading the wrong file');
  return [...block[1]!.matchAll(/^\s*'([^']+)':|^\s*"([^"]+)":/gm)].map((m) => (m[1] ?? m[2])!);
})();

/** The names actively nulled after the map runs. */
const nulled = (() => {
  const block = SEED.match(/const UNVERIFIED_PHOTOS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('UNVERIFIED_PHOTOS not found — this gate is reading the wrong file');
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
})();

describe('the two halves of the fix cannot contradict each other', () => {
  it('no item is given a photo and then stripped of it', () => {
    const both = mapNames.filter((n) => nulled.includes(n));
    expect(
      both,
      'a name in both the map and the nulling list means the seed sets a URL and immediately clears it — either the photo was verified (remove it from the nulling list) or it was not (remove it from the map)',
    ).toEqual([]);
  });

  it('the nulling runs AFTER the map, or it clears nothing', () => {
    // Order is load-bearing: the map's `where: { imageUrl: null }` would
    // re-apply a bad URL to a row the sweep had just cleaned.
    expect(SEED.indexOf('const itemImages')).toBeLessThan(SEED.indexOf('UNVERIFIED_PHOTOS'));
  });

  it('the sweep only touches photos the seed itself handed out', () => {
    // A real merchant upload must never be stomped by a demo-data sweep.
    expect(SEED).toMatch(/imageUrl: \{ startsWith: 'https:\/\/images\.unsplash\.com\/' \}/);
  });
});

describe('the names found wrong stay found wrong', () => {
  it.each([
    ['Mauby', 'a cheeseburger'],
    ['Pork Chops', 'a basket of baguettes'],
    ['Screwdriver Set (6pc)', 'one screwdriver, not six'],
    ['Emulsion Paint 4L — White', 'a roller spreading BLUE paint'],
    ['LED Bulb 9W (2-pack)', 'one lit incandescent filament bulb'],
  ])('%s is still nulled — its photo was %s', (name) => {
    expect(nulled, `${name} was checked by opening the photograph`).toContain(name);
  });

  it('the items that passed keep their photographs', () => {
    // The gate must not read as "nulling everything is safest". A verified
    // photograph is worth more than a placeholder, and Claw Hammer's is a
    // claw hammer.
    expect(mapNames).toContain('Claw Hammer');
    expect(nulled).not.toContain('Claw Hammer');
  });

  it('guards the guard — both lists parsed to something real', () => {
    // Without this, a regex that silently matched nothing would make every
    // assertion above pass against an empty array.
    expect(mapNames.length).toBeGreaterThan(20);
    expect(nulled.length).toBeGreaterThan(5);
    expect(mapNames).toContain('Basmati Rice 5kg');
  });
});

describe('what has NOT been checked is named, not implied', () => {
  it('the grocery shelf is still unaudited, and the file says so somewhere', () => {
    // Honesty about coverage: the food pass covered restaurant dishes, the
    // retail pass covered City Hardware. The ~20 SUPERMARKET item photos have
    // never had anyone open them. That is a known gap, and a known gap written
    // down is a task; an unwritten one is a surprise.
    expect(
      SEED,
      'the seed must say which shelves have been eyeballed and which have not',
    ).toMatch(/F-264 was a FOOD pass/);
  });
});
