/**
 * storefront-seller-block.test.ts makes each store from an index (phone, slug and name all
 * carry it), so two stores with the same index collide on a unique key. A random draw once
 * did exactly that (main and #1860's API shard 2 reds, 18 Oct 2026). This reads the file and
 * keeps every index fixed and unique.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'storefront-seller-block.test.ts'), 'utf8');

/** Every store() index the file uses: the literal ones plus REFUSAL_BASE + each refusal row. */
function storeIndexes(text: string): { indexes: number[]; unexplained: string[] } {
  const args = [...text.matchAll(/\bstore\(([^,)]*)/g)].map((m) => m[1]!.trim()).filter((a) => a !== 'n: number');
  const literal = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const unexplained = args.filter((a) => !/^\d+$/.test(a) && a !== 'n');
  const base = Number(/const REFUSAL_BASE = (\d+);/.exec(text)?.[1] ?? NaN);
  const block = /const REFUSALS = \[([\s\S]*?)\n\s*\] as const;/.exec(text)?.[1] ?? '';
  const rows = block.split('\n').filter((line) => /^\s*\[/.test(line)).length;
  const refusals = args.includes('n') ? Array.from({ length: rows }, (_, row) => base + row) : [];
  return { indexes: [...literal, ...refusals], unexplained };
}

describe('the seller-block test file never gives two stores the same index', () => {
  it('every store() index is fixed: no random draw, no expression the guard cannot read', () => {
    expect(source).not.toMatch(/Math\.random/);
    expect(storeIndexes(source).unexplained).toEqual([]);
    // The refusal rows' index really is base + row (the guard counts them that way).
    expect(source).toContain('[what, text, code, REFUSAL_BASE + row] as const');
  });

  it('every index is unique, the refusal rows included', () => {
    const { indexes } = storeIndexes(source);
    expect(indexes.length).toBeGreaterThanOrEqual(14);
    expect(indexes.filter((n, i) => indexes.indexOf(n) !== i)).toEqual([]);
    expect(indexes.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  });
});
