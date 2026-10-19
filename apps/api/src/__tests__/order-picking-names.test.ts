/**
 * order-picking.test.ts names its items from a plain word and a counter. The prohibited-items
 * gate judges every item by its words, so a name with random letters could spell a banned word
 * ("Sub rumVg5" -> rum, "Sub XN4-Rx" -> rx) and the substitute was then hidden: the float-cap
 * case answered SUBSTITUTE_UNAVAILABLE instead of SUBSTITUTE_FLOAT_EXCEEDED (#1869's run
 * 39169302187, 18 Oct 2026). This reads the file and runs every item name through the real gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkItem, isHidden } from '../modules/compliance/prohibited-items';

const source = readFileSync(join(__dirname, 'order-picking.test.ts'), 'utf8');

/** Each makeItem name as the file writes it, and the name it makes (counters as a number). */
function itemNames(text: string): { made: string[]; unexplained: string[] } {
  const made: string[] = [];
  const unexplained: string[] = [];
  for (const [, arg] of text.matchAll(/makeItem\(\{ name: (`[^`]*`|'[^']*'|itemName\('[^']*'\)|[^,}]+)/g)) {
    const a = arg!.trim();
    const counted = /^itemName\('([^'`$]+)'\)$/.exec(a);
    const template = /^`([^`]*)`$/.exec(a);
    const literal = /^'([^']*)'$/.exec(a);
    if (counted) made.push(`${counted[1]} 7`);
    else if (template && template[1]!.replace(/\$\{seq\}/g, '').indexOf('${') === -1) made.push(template[1]!.replace(/\$\{seq\}/g, '7'));
    else if (literal) made.push(literal[1]!);
    else unexplained.push(a);
  }
  return { made, unexplained };
}

const clear = (name: string) => !isHidden(checkItem({
  name, description: null, sectionName: 'Groceries', optionNames: [], categories: [], storeCategories: [],
  prohibitedAt: null, prohibitedClass: null, prohibitedReason: null, reviewApprovedHash: null,
}));

describe('order-picking.test.ts never names an item with random letters the prohibited gate could hide', () => {
  it('every item name is plain words and a counter: no random draw, nothing the guard cannot read', () => {
    const { made, unexplained } = itemNames(source);
    expect(unexplained).toEqual([]);
    expect(made.length).toBeGreaterThanOrEqual(40);
    expect(source).not.toMatch(/name: `[^`]*\$\{(nanoid|Math\.random|randomUUID)/);
  });

  it('every one of those names is clear at the prohibited-items gate', () => {
    expect(itemNames(source).made.filter((name) => !clear(name))).toEqual([]);
  });

  it('the gate really does hide a random draw that spells a banned word (what this guards against)', () => {
    expect(clear('Sub rumVg5')).toBe(false);
    expect(clear('Sub 7')).toBe(true);
  });
});
