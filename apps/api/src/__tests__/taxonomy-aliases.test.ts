import { describe, it, expect } from 'vitest';
import { suggestCategories, CAT_MATCH_MIN } from '../modules/discovery/matcher';
import { SEED_TAXONOMY } from '../modules/discovery/taxonomy.seed';

/**
 * THE ALIAS DICTIONARY, GRADED AGAINST REAL STOCK.
 *
 * The seeded aliases were written before any goods existed, so they held the
 * CATEGORY's words — `tools`, `plumbing`, `electrical` — and not the words a
 * shopkeeper types on a price tag. Measured against the first real retail
 * catalogue on the platform, a Georgetown hardware store:
 *
 *     Emulsion Paint 4L    -> hardware-tools   (only `paint` caught it)
 *     Claw Hammer          -> NO MATCH
 *     Screwdriver Set      -> NO MATCH
 *     Measuring Tape 5m    -> NO MATCH
 *     LED Bulb 9W          -> NO MATCH
 *
 * One item in five. The Market tab cannot show categories that nothing is
 * tagged into, so the whole rail was empty for a store whose entire stock is
 * plainly hardware.
 *
 * This file is the regression guard, written from the ACTUAL item names rather
 * than from invented ones — the point is that the dictionary tracks the shelf,
 * and the seed's own instruction is "extend them as real menus teach you".
 */

const RETAIL = SEED_TAXONOMY
  .filter((c) => (c as { vertical: string }).vertical === 'RETAIL')
  .map((c) => ({ slug: c.slug, name: c.name, aliases: (c as { aliases: string[] }).aliases }));

const match = (name: string, description: string | null = null) =>
  suggestCategories({ name, description } as never, RETAIL as never);

const top = (name: string) => match(name)[0]?.slug ?? null;

describe('real stock from the first retail catalogue is placed', () => {
  // These five names are verbatim from the live database.
  it.each([
    ['Claw Hammer', 'hardware-tools'],
    ['Screwdriver Set (6pc)', 'hardware-tools'],
    ['Measuring Tape 5m', 'hardware-tools'],
    ['LED Bulb 9W (2-pack)', 'hardware-tools'],
    ['Emulsion Paint 4L — White', 'hardware-tools'],
  ])('%s → %s', (name, slug) => {
    expect(top(name), `${name} found no category — the dictionary is behind the shelf`).toBe(slug);
  });

  it('every one of them clears the gate, which was never the problem', () => {
    // The gate stays at 0.6. The fix was the dictionary, not the threshold —
    // the matcher's own rule is "extend aliases, never lower the gate".
    expect(CAT_MATCH_MIN).toBe(0.6);
    for (const name of ['Claw Hammer', 'Measuring Tape 5m', 'LED Bulb 9W (2-pack)']) {
      expect(match(name)[0]!.confidence).toBeGreaterThanOrEqual(CAT_MATCH_MIN);
    }
  });
});

describe('a spread of ordinary Georgetown goods lands somewhere sensible', () => {
  it.each([
    ['Ladies Blouse', 'fashion'],
    ['Boys School Shoes', 'shoes'],
    ['Samsung Charger', 'electronics'],
    ['Non-stick Frying Pan', 'home-kitchen'],
    ['Car Battery 12V', 'auto-parts'],
    ['Exercise Book 80pg', 'stationery-books'],
    ['Dog Food 2kg', 'pets'],
  ])('%s → %s', (name, slug) => {
    expect(top(name)).toBe(slug);
  });
});

describe('precision — a wrong tag is worse than no tag', () => {
  it('a hammer is never beauty, and a lipstick is never hardware', () => {
    // The failure mode that matters: a plausible-looking rail that files goods
    // under the wrong aisle teaches customers to distrust every category.
    expect(match('Claw Hammer').map((m) => m.slug)).not.toContain('beauty');
    expect(match('Matte Lipstick').map((m) => m.slug)).not.toContain('hardware-tools');
  });

  it('the deliberately-omitted ambiguous words are still omitted', () => {
    // Each reads differently across two retail categories, and each is left out
    // on purpose. If someone adds one, this says why it was not there.
    const allAliases = RETAIL.flatMap((c) => c.aliases.map((a) => a.toLowerCase()));
    for (const word of ['switch', 'iron', 'filter', 'mirror']) {
      expect(
        allAliases,
        `"${word}" reads two ways across retail categories — a phrase is safe, the bare word is not`,
      ).not.toContain(word);
    }
    // `tape` is the instructive one: banned bare, allowed as a phrase.
    expect(allAliases).not.toContain('tape');
    expect(allAliases).toContain('measuring tape');
  });

  it('nothing scoring below the gate is offered at all', () => {
    // A name with no retail signal must return nothing rather than the
    // least-bad guess.
    expect(match('Xyzzy 400')).toEqual([]);
  });

  it('at most three categories per item, best first', () => {
    const hits = match('LED Bulb Wire Socket Screwdriver Hammer Paint');
    expect(hits.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]!.confidence).toBeGreaterThanOrEqual(hits[i]!.confidence);
    }
  });
});

describe('the seed law holds', () => {
  it('no seeded alias was removed — the dictionary only grows', () => {
    // "Extend them as real menus teach you, never trim the seeds." These are the
    // originals; a re-seed unions aliases, so trimming here would silently
    // orphan tags an operator already has.
    const hardware = RETAIL.find((c) => c.slug === 'hardware-tools')!;
    for (const original of ['tools', 'paint', 'plumbing', 'electrical']) {
      expect(hardware.aliases, `${original} was a seeded alias`).toContain(original);
    }
    const fashion = RETAIL.find((c) => c.slug === 'fashion')!;
    for (const original of ['clothes', 'dress', 'jeans', 'shirt']) {
      expect(fashion.aliases).toContain(original);
    }
  });

  it('slugs are untouched — they are immutable by contract', () => {
    // A changed slug orphans every tag pointing at it; `mergedIntoId` is what
    // renaming is for.
    const slugs = RETAIL.map((c) => c.slug).sort();
    expect(slugs).toEqual([
      'auto-parts', 'beauty', 'electronics', 'fashion', 'flowers-gifts',
      'hardware-tools', 'home-kitchen', 'pets', 'pharmacy', 'phone-accessories',
      'shoes', 'sports', 'stationery-books', 'toys-games',
    ]);
  });
});
