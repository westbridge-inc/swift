import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  MAX_SLIP_FORMS, MAX_SLIP_WORD_LENGTH, MAX_TERMS, MIN_TYPO_LENGTH, literalForms, slipGate, nameMatcher, searchTerms, searchTiers, typoForms, wholeQueryLiteral,
} from '../modules/search/forgiving-text';
import { SearchService, TYPO_TOLERANCE, type SearchClientLike, type SearchIndexLike } from '../modules/search/search.service';
import { ITEM_INDEX, VENDOR_INDEX } from '../modules/search/search-scope';

// The pure half of forgiving search (owner, 13 Oct). The database half and the
// HTTP doors are proved in search-forgiving.test.ts / search-engine-fill.test.ts.

/** Every `contains` / `startsWith` value a predicate holds, walked out of the tree. */
function likeValues(where: unknown, out: string[] = []): string[] {
  if (Array.isArray(where)) { for (const w of where) likeValues(w, out); return out; }
  if (where && typeof where === 'object') {
    for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
      if ((k === 'contains' || k === 'startsWith') && typeof v === 'string') out.push(v);
      else likeValues(v, out);
    }
  }
  return out;
}

describe('what a customer types never becomes a wildcard', () => {
  it('[review S3-2] a query of only short words is searched as one exact piece, metacharacters removed', () => {
    expect(wholeQueryLiteral('A&W')).toBe('A&W');
    expect(wholeQueryLiteral(' b ')).toBe('b');
    expect(wholeQueryLiteral('5%_\\')).toBe('5');
    expect(wholeQueryLiteral('%_')).toBeNull();
    const tiers = searchTiers('A&W', { text: ['name'], typoText: ['name'] });
    expect(tiers).toEqual([{ tier: { every: true, typos: false }, where: { OR: [{ name: { contains: 'A&W', mode: 'insensitive' } }] } }]);
    expect(nameMatcher('A&W', true)('A&W Grill')).toBe(true);
    expect(nameMatcher('A&W', true)('Grill')).toBe(false);
  });

  it('a query of LIKE metacharacters has no searchable word at all', () => {
    expect(searchTerms('%%')).toEqual([]);
    expect(searchTerms('__')).toEqual([]);
    expect(searchTiers('%_\\', { text: ['name'], typoText: ['name'] })).toEqual([]);
  });

  it('metacharacters inside a query split it into plain words', () => {
    expect(searchTerms('chi%cken_curry\\roti')).toEqual(['chi', 'cken', 'curry', 'roti']);
  });

  it('the only wildcard in any pattern is the one-letter slip, and only in a slip form', () => {
    const tiers = searchTiers('Chicken 100% curry_roti', { text: ['name', 'description'], typoText: ['name'], lists: ['tags'] });
    const values = tiers.flatMap((t) => likeValues(t.where));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^ ?[\p{L}\p{N}_]+$/u);
    for (const v of likeValues(tiers[0]!.where)) expect(v).not.toContain('_'); // the exact tier has none
  });
});

describe('words and forms', () => {
  it('splits, lower-cases, de-duplicates and bounds the words', () => {
    expect(searchTerms('  Curry   CHICKEN curry ')).toEqual(['curry', 'chicken']);
    expect(searchTerms('a b c d e f g h')).toEqual([]);
    expect(searchTerms('one two three four five six seven')).toHaveLength(MAX_TERMS);
  });

  it('undoes the plural the customer typed', () => {
    expect(literalForms('burgers')).toContain('burger');
    expect(literalForms('patties')).toContain('patty');
    expect(literalForms('tomatoes')).toContain('tomato');
    expect(literalForms('pies')).toContain('pie');
    expect(literalForms('glass')).toEqual(['glass']);
    expect(literalForms('bus')).toEqual(['bus']);
  });

  it('forgives one slip from MIN_TYPO_LENGTH letters, never below', () => {
    expect(typoForms('a'.repeat(MIN_TYPO_LENGTH - 1))).toEqual([]);
    const forms = typoForms('chiken');
    expect(forms).toContain('chi_ken'); // the missing letter
    expect(forms).toContain('chken'); // an extra letter typed
    expect(forms).toContain('chi_en'); // a wrong letter
    expect(forms).toContain('chikne'); // two letters swapped
    expect(forms).not.toContain('chiken');
  });

  it('never forgives a slip in the FIRST letter (as the index does): every form starts as the word does', () => {
    for (const f of typoForms('chicken')) expect(f.startsWith('c')).toBe(true);
    expect(typoForms('bread')).not.toContain('read');
    expect(typoForms('chicken')).not.toContain('_hicken');
    expect(typoForms('chicken')).not.toContain('hcicken');
  });

  it('[DS1080 S2] the size of a query is bounded, however it is typed', () => {
    // one pasted run of letters: matched as typed, no slip forms at all
    expect(typoForms('a'.repeat(MAX_SLIP_WORD_LENGTH + 1))).toEqual([]);
    expect(typoForms('x'.repeat(200))).toEqual([]);
    expect(typoForms('abcdefghijklmnopqrst').length).toBeGreaterThan(0);
    // five long words: the slip budget, not the word count, bounds the slip clauses
    const cols = { text: ['name', 'description'], typoText: ['name'] } as const;
    const q = 'abcdefghijklmnopqrst bcdefghijklmnopqrstu cdefghijklmnopqrstuv defghijklmnopqrstuvw efghijklmnopqrstuvwx';
    for (const { where } of searchTiers(q, cols)) {
      const slipClauses = likeValues(where).filter((v) => v.includes('_') || v.startsWith(' ')).length;
      expect(slipClauses).toBeLessThanOrEqual(2 * MAX_SLIP_FORMS);
    }
    const all = searchTiers(q, cols).flatMap((t) => likeValues(t.where));
    expect(all.length).toBeLessThan(600);
  });

  it('the in-memory twin agrees: literal anywhere, a slip only at a word start', () => {
    expect(nameMatcher('doori', false)('Tandoori Chicken')).toBe(true);
    expect(nameMatcher('chiken', false)('Chicken Curry')).toBe(false);
    expect(nameMatcher('chiken', true)('Chicken Curry')).toBe(true);
    expect(nameMatcher('chiken', true)('Curry Chicken')).toBe(true);
    // a slip form must start a word: "toast" one letter short is "tast", inside "Fantastic"
    expect(nameMatcher('toast', true)('Fantastic Fries')).toBe(false);
    expect(nameMatcher('toast', true)('Tast Bun')).toBe(true);
    // and never changes the first letter
    expect(nameMatcher('chicken', true)('Thicken Gravy')).toBe(false);
  });

  it('tiers run strictest first and skip what cannot add anything', () => {
    const cols = { text: ['name'], typoText: ['name'] } as const;
    expect(searchTiers('chicken', cols).map((t) => t.tier)).toEqual([{ every: true, typos: false }, { every: true, typos: true }]);
    expect(searchTiers('roti', cols).map((t) => t.tier)).toEqual([{ every: true, typos: false }]);
    expect(searchTiers('curry chicken', cols).map((t) => t.tier)).toEqual([
      { every: true, typos: false }, { every: true, typos: true }, { every: false, typos: false }, { every: false, typos: true },
    ]);
    // no column forgives a slip: no slip tier
    expect(searchTiers('chicken', { text: ['description'] }).map((t) => t.tier)).toEqual([{ every: true, typos: false }]);
  });
});

describe('[review S2-1] every slip clause sits behind a cheap, exact gate', () => {
  /** Walk a predicate; report every slip clause (a value with `_`, or a ' '-anchored form
   *  longer than one letter) together with whether it is inside AND[gate, OR[slips]]. */
  function slipPlacements(where: unknown, gated = false, out: Array<{ value: string; gated: boolean }> = []) {
    if (Array.isArray(where)) { for (const w of where) slipPlacements(w, gated, out); return out; }
    if (!where || typeof where !== 'object') return out;
    const obj = where as Record<string, unknown>;
    if (Array.isArray(obj['AND']) && obj['AND'].length === 2) {
      const [gate, slips] = obj['AND'] as [unknown, unknown];
      const values = likeValues(gate);
      // a gate holds no wildcard, and its word-start pieces are two letters
      const isGate = values.length > 0 && values.every((v) => !v.includes('_'));
      if (isGate) { slipPlacements(slips, true, out); return out; }
    }
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'contains' || k === 'startsWith') && typeof v === 'string') {
        if (v.includes('_') || (k === 'startsWith' && v.length > 1) || (v.startsWith(' ') && v.length > 2)) out.push({ value: v, gated });
      } else slipPlacements(v, gated, out);
    }
    return out;
  }

  it.each(['chiken', 'curry chikcen', 'brocoli tomatoes salad rice wrap'])('"%s"', (q) => {
    const cols = { text: ['name', 'description'], typoText: ['name'], lists: ['tags'] } as const;
    const slipTiers = searchTiers(q, cols).filter((t) => t.tier.typos);
    expect(slipTiers.length).toBeGreaterThan(0);
    for (const { where } of slipTiers) {
      const placed = slipPlacements(where);
      expect(placed.length).toBeGreaterThan(0);
      expect(placed.filter((p) => !p.gated)).toEqual([]);
    }
  });

  it('the gate is exactness-preserving: every text any slip form matches passes it (enumerated)', () => {
    const passes = (text: string, term: string) => {
      const g = slipGate(term);
      const t = text.toLowerCase();
      return g.wordStarts.some((p) => t.startsWith(p) || t.includes(` ${p}`)) || t.includes(g.inside);
    };
    let checked = 0;
    for (const word of ['chiken', 'brocoli', 'tandori', 'aabba', 'pepperpot', 'abcdefghijklmnopqrst']) {
      for (const form of typoForms(word)) {
        // fill the one-letter wildcard every possible way, and place the form at a word start
        for (const fill of ['a', 'z', word[1]!, word[2]!]) {
          const piece = form.replace('_', fill);
          for (const text of [piece, `x ${piece}`, `${piece}y`, `hot ${piece}s here`]) {
            expect(passes(text, word), `${word} / ${form} / "${text}"`).toBe(true);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(slipGate('chiken')).toEqual({ wordStarts: ['ch', 'ci'], inside: 'iken' });
  });
});

describe('the index is told to forgive, on every start', () => {
  it('initialize() writes the pinned typo tolerance to BOTH indexes', async () => {
    const settings = new Map<string, Record<string, unknown>>();
    const index = (uid: string): SearchIndexLike => ({
      addDocuments: async () => ({}), deleteDocument: async () => ({}), deleteDocuments: async () => ({}),
      getDocuments: async () => ({ results: [] }), search: async () => ({ hits: [], processingTimeMs: 0 }),
      updateSettings: async (s) => { settings.set(uid, s); return {}; },
    });
    const client: SearchClientLike = { createIndex: async () => ({}), index };
    await new SearchService({} as PrismaClient, undefined, undefined, client).initialize();
    expect(TYPO_TOLERANCE).toEqual({ enabled: true, minWordSizeForTypos: { oneTypo: MIN_TYPO_LENGTH, twoTypos: 9 } });
    expect(settings.get(VENDOR_INDEX)?.['typoTolerance']).toEqual(TYPO_TOLERANCE);
    expect(settings.get(ITEM_INDEX)?.['typoTolerance']).toEqual(TYPO_TOLERANCE);
  });
});
