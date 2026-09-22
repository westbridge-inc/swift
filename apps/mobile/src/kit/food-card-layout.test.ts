import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./food.tsx', import.meta.url), 'utf8');

describe('compact FoodCard metadata layout', () => {
  it('gives price and merchant metadata separate bounded lines', () => {
    const card = SOURCE.slice(SOURCE.indexOf('export function FoodCard'), SOURCE.indexOf('/** Kit vendor row'));

    expect(card).toContain('<T variant="numM" numberOfLines={1}>');
    expect(card).toMatch(/minHeight: 18[\s\S]*<RatingMeta/);
    expect(card).not.toMatch(/justifyContent: 'space-between'[\s\S]*<RatingMeta/);
  });

  it('truncates long merchant metadata instead of painting through its neighbour', () => {
    const meta = SOURCE.slice(SOURCE.indexOf('export function RatingMeta'), SOURCE.indexOf('/** Kit 2-col'));

    expect(meta).toMatch(/key="extra"[\s\S]*numberOfLines=\{1\}[\s\S]*flexShrink: 1/);
    expect(meta).toContain("overflow: 'hidden'");
  });
});
