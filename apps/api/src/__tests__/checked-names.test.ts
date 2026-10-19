/**
 * [flake class 4 · helpers/fixture-ids.ts] No test builds a name the prohibited-items checker reads
 * from random letters. The checker judges an item's, a store's, a menu section's and a platform
 * category's own words (look-alike digits too), so `Sub ${nanoid(6)}` is hidden about once in a few
 * thousand draws ("Sub rumVg5" -> rum) and the suite reds with an answer it never meant to test
 * (order-picking SUBSTITUTE_UNAVAILABLE, #1869 run 39169302187). Those names use wordFreeTag()
 * (digits only). This reads every API test file and runs the helper through the real checker.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { nanoid } from 'nanoid';
import { checkItem, isHidden } from '../modules/compliance/prohibited-items';
import { wordFreeTag } from './helpers/fixture-ids';

/** The fields the checker reads (item/store/section/option words; a parcel's description; a refund rule). */
const CHECKED_FIELD = /\b(name|description|tags|cuisineTypes|slug|sectionName|substituteName|packageDescription|refundRule)\s*:\s*(`[^`]*`)/g;
/** Rows whose names the checker never reads. */
const UNCHECKED_MODELS = new Set(['tenant', 'adCampaign', 'adPlacement', 'zone', 'customer', 'reviewSession', 'deviceToken', 'user']);
/** Random draws that can hold letters: nanoid/fixtureTag, base-36/hex strings, UUIDs (short hex like 'cbd' is a hit too). */
const RANDOM = '(?:nanoid\\(|fixtureTag\\(|randomUUID\\(|Math\\.random\\(\\)\\.toString\\(|randomBytes\\([^)]*\\)\\.toString\\(|Date\\.now\\(\\)\\.toString\\(36)';
const MODEL = /\.(\w+)\.(?:create|upsert|createMany|update|updateMany)\(|\b(vendors|items|optionGroups|options|category|menuCategories|categories|vendor|item)\s*:\s*\{\s*(?:create|connectOrCreate)/g;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return testFiles(path);
    return path.endsWith('.ts') && !path.endsWith('checked-names.test.ts') && !path.endsWith('fixture-ids.ts') ? [path] : [];
  });
}

/** Every checked name in a file built from random letters: `file:line field template`. */
export function randomCheckedNames(file: string, source: string): string[] {
  const lines = source.split('\n');
  const randomVars = [...source.matchAll(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*(?:String\\()?(?:${RANDOM}|\`[^\`]*\\$\\{[^}]*${RANDOM})`, 'g'))].map((m) => m[1]!);
  const found: string[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CHECKED_FIELD)) {
      const [, field, template] = m;
      let model = '?';
      for (const text of [line.slice(0, m.index), ...lines.slice(Math.max(0, i - 12), i).reverse()]) {
        const hits = [...text.matchAll(MODEL)];
        if (hits.length) { model = hits[hits.length - 1]![1] ?? hits[hits.length - 1]![2]!; break; }
      }
      if (UNCHECKED_MODELS.has(model) || (field === 'slug' && model !== 'discoveryCategory')) continue;
      const direct = new RegExp(`\\$\\{[^}]*${RANDOM}`).test(template!);
      const viaVar = randomVars.filter((v) => new RegExp(`\\$\\{${v}\\b`).test(template!));
      if (direct || viaVar.length) found.push(`${file}:${i + 1} ${field}@${model} ${template!.slice(0, 60)}`);
    }
    // A name held in a variable first: `const name = \`Shop ${nanoid(4)}\``.
    const held = new RegExp(`(?:const|let)\\s+(name|description)\\s*=\\s*\`[^\`]*\\$\\{[^}]*${RANDOM}`).exec(line);
    if (held) found.push(`${file}:${i + 1} ${held[1]} (held) ${line.trim().slice(0, 60)}`);
  });
  return found;
}

const clear = (name: string) => !isHidden(checkItem({
  name, description: null, sectionName: 'Groceries', optionNames: [], categories: [], storeCategories: [],
  prohibitedAt: null, prohibitedClass: null, prohibitedReason: null, reviewApprovedHash: null,
}));

describe('no API test builds a checked name from random letters', () => {
  it('every name, description and category slug the checker reads uses wordFreeTag(), never nanoid() or fixtureTag()', () => {
    const files = testFiles(__dirname);
    expect(files.length).toBeGreaterThan(400);
    const found = files.flatMap((file) => randomCheckedNames(relative(__dirname, file), readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });

  it('the guard sees the shapes it guards against', () => {
    expect(randomCheckedNames('x.ts', "await prisma.item.create({ data: { name: `Sub ${nanoid(6)}` } });")).toHaveLength(1);
    expect(randomCheckedNames('x.ts', "const RUN = nanoid(6);\nawait prisma.vendor.create({ data: { name: `Shop ${RUN}` } });")).toHaveLength(1);
    expect(randomCheckedNames('x.ts', "const name = `Gone ${fixtureTag(8)}`;")).toHaveLength(1);
    expect(randomCheckedNames('x.ts', "const RUN = Math.random().toString(36).slice(2, 8);\nawait prisma.item.create({ data: { name: `Dish ${RUN}` } });")).toHaveLength(1);
    expect(randomCheckedNames('x.ts', "await prisma.vendor.create({ data: { name: `Shop ${randomBytes(3).toString('hex')}` } });")).toHaveLength(1);
    expect(randomCheckedNames('x.ts', "await prisma.tenant.create({ data: { name: `T ${nanoid(6)}` } });")).toEqual([]);
    expect(randomCheckedNames('x.ts', "await prisma.vendor.create({ data: { slug: `s-${nanoid(6)}` } });")).toEqual([]);
  });

  it('a wordFreeTag() name is always clear at the real checker; a random-letter one is not', () => {
    const tagged = Array.from({ length: 20_000 }, () => `Sub ${wordFreeTag(8)}`);
    expect(tagged.filter((name) => !clear(name))).toEqual([]);
    expect(clear('Sub rumVg5')).toBe(false); // a real nanoid(6) draw
    const drawn = Array.from({ length: 50_000 }, () => `Sub ${nanoid(6)}`);
    expect(drawn.some((name) => !clear(name))).toBe(true); // ~1 in 3,000: what wordFreeTag() removes
  });
});
