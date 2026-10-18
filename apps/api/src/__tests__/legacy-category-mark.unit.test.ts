import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { legacyCategoryMark } from '../modules/discovery/legacy-category-mark';

// [#1854 S4, COORD 18 Oct] App builds 9-11 draw a category's `emoji` field as
// its tile. A category created since the owner's no-emoji rule stores emoji '',
// which drew a BLANK tile there. The API serves the name's first letter instead
// (plain uppercase text, never an emoji); builds with the icon rail ignore it.
const isEmoji = (ch: string) => /\p{Extended_Pictographic}/u.test(ch) && /\p{Emoji}/u.test(ch);

describe('the legacy emoji field is never blank', () => {
  it('an empty or blank emoji becomes the first letter of the name, uppercase', () => {
    expect(legacyCategoryMark({ emoji: '', name: 'fusion kitchen' })).toBe('F');
    expect(legacyCategoryMark({ emoji: '  ', name: 'Power Tools' })).toBe('P');
    expect(legacyCategoryMark({ emoji: null, name: '& More', slug: 'and-more' })).toBe('M');
    expect(legacyCategoryMark({ emoji: '', name: '24-hour pharmacy' })).toBe('2');
    expect(legacyCategoryMark({ emoji: '', name: '', slug: 'x-ray' })).toBe('X');
  });
  it('a stored mark is kept as it is (seeded rows on live databases)', () => {
    expect(legacyCategoryMark({ emoji: 'P', name: 'Pizza' })).toBe('P');
  });
  it('the letter is never an emoji', () => {
    for (const name of ['Fusion', 'élan', 'Ōmiya', '7-Eleven']) {
      const mark = legacyCategoryMark({ emoji: '', name });
      expect(mark).toHaveLength(1);
      expect([...mark].filter(isEmoji)).toEqual([]);
    }
  });
});

// Census: every place the discovery module serves a category's `emoji` goes
// through legacyCategoryMark, so no endpoint can serve a blank one.
describe('no discovery endpoint serves the raw emoji column', () => {
  const dir = join(__dirname, '..', 'modules', 'discovery');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && statSync(join(dir, f)).isFile());
  it('every `emoji:` value in a served shape is legacyCategoryMark(...)', () => {
    const raw: string[] = [];
    for (const f of files) {
      if (f === 'taxonomy.seed.ts' || f === 'admin-governance.ts' || f === 'legacy-category-mark.ts') continue;
      readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/\bemoji:\s*\w+\.emoji\b/.test(line)) raw.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(raw).toEqual([]);
    const served = files.map((f) => readFileSync(join(dir, f), 'utf8').match(/emoji: legacyCategoryMark\(/g)?.length ?? 0).reduce((a, b) => a + b, 0);
    expect(served).toBe(5);
  });
});
