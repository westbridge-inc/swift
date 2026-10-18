import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddPlusGlyph } from '@/components/add-plus';
import { STORE_PICK } from '@/lib/store-pick';

// ---------------------------------------------------------------------------
// [Triage rows 2 + 113 · GUARDRAILS §8 honesty] The store's own isPopular tick
// reads "Store’s pick" on the storefront (never "Popular": that reads as
// measured social proof), and every add-to-cart "+" is the one shared maroon
// circle (Market cards and the storefront Add button).
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('storefront honesty and the shared add "+"', () => {
  it('the storefront labels the store’s tick "Store’s pick"', () => {
    expect(STORE_PICK).toBe('Store’s pick');
    const page = read('src/components/storefront/storefront-experience.tsx');
    expect(page).toContain('{item.isPopular ? <span className={styles.popular}>{STORE_PICK}</span> : null}');
    expect(page).not.toMatch(/>Popular</);
  });

  it('the shared glyph is a hidden maroon circle with a white plus', () => {
    const { container } = render(<AddPlusGlyph />);
    const glyph = container.querySelector('[data-add-plus]')!;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.className).toContain('rounded-full');
    expect(glyph.className).toContain('bg-[var(--swift-red)]');
    expect(glyph.className).toContain('text-[var(--swift-white)]');
    expect(glyph.querySelector('svg')).not.toBeNull();
  });

  it('Market cards and the storefront Add button both use it; neither draws its own', () => {
    const market = read('src/app/(app)/market/market-screen.tsx');
    expect(market).toContain('<AddPlusGlyph />');
    expect(market).not.toContain('<Plus size={18} />');
    const page = read('src/components/storefront/storefront-experience.tsx');
    expect(page).toMatch(/className=\{styles\.addButton\}[\s\S]{0,1200}<AddPlusGlyph \/>\s*<\/button>/);
    expect(page).not.toMatch(/>\s*Add\s*<\/button>/);
  });
});
