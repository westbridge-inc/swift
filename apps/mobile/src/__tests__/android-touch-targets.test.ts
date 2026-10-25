import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_TOUCH_DP, touchTarget } from '../kit/touch-target';

/**
 * [ANDROID-QA] Touch targets and spoken names that Android's accessibility
 * tools (and Google Play's pre-launch report) flagged on an emulator pass.
 * They measure a control's own bounds, never hitSlop, so the small header
 * glyphs, the cart's Remove and the steppers read as 18–32dp targets. Labels
 * fell back to icon names ("chevron left", "share 2") or read icon-font glyphs.
 */

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

describe('touchTarget: a 48dp box that does not move the glyph', () => {
  it('grows a small glyph to 48dp and cancels the growth with a negative margin', () => {
    expect(MIN_TOUCH_DP).toBe(48);
    expect(touchTarget(22)).toMatchObject({ minWidth: 48, minHeight: 48, margin: -13 });
    expect(touchTarget(44)).toMatchObject({ minWidth: 48, minHeight: 48, margin: -2 });
  });

  it('leaves an already large control alone', () => {
    expect(touchTarget(56)).toMatchObject({ minWidth: 48, minHeight: 48, margin: -0 });
  });
});

describe('the flagged controls are 48dp', () => {
  it.each([
    ['modules/cart/screens/CartScreen.tsx', 'accessibilityLabel="Back" style={touchTarget(24)}'],
    ['modules/cart/screens/CartScreen.tsx', 'accessibilityLabel="Cart options" style={touchTarget(22)}'],
    ['modules/cart/screens/CartScreen.tsx', 'accessibilityLabel={`Remove ${it.name}`}\n                          style={touchTarget(18)}'],
    ['modules/shop/screens/HomeScreen.tsx', 'accessibilityLabel="Notifications"\n                style={touchTarget(22)}'],
    ['modules/shop/screens/SearchScreen.tsx', 'accessibilityLabel="Go back"\n            style={touchTarget(24)}'],
    ['kit/screen.tsx', 'style={touchTarget(size)}'],
    ['kit/controls.tsx', 'style={{ ...touchTarget(size), opacity: disabled ? 0.4 : 1 }}'],
  ])('%s', (file, snippet) => {
    expect(read(file)).toContain(snippet);
  });
});

describe('every control speaks the words it shows', () => {
  it('no CircleChip falls back to its icon name as its spoken label', () => {
    const unlabeled: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<CircleChip\b([\s\S]*?)\/>/g)) {
        if (!/\blabel=/.test(m[1]!)) unlabeled.push(`${file.slice(SRC.length + 1)}: ${m[1]!.trim().slice(0, 40)}`);
      }
    }
    expect(unlabeled).toEqual([]);
  });

  it('the customer-facing switches carry their row names', () => {
    expect(read('modules/profile/screens/ProfileScreen.tsx')).toMatch(/<BrandSwitch\s+label="Marketing messages"/);
    expect(read('modules/profile/screens/AddAddressScreen.tsx')).toContain('<BrandSwitch label="Set as default address"');
    expect(read('modules/cart/screens/CartScreen.tsx')).toContain('<BrandSwitch label="Express delivery"');
    expect(read('kit/controls.tsx')).toContain('accessibilityLabel={label}');
  });

  it('the store info columns speak value and caption, not the icon glyph', () => {
    expect(read('modules/shop/screens/RestaurantScreen.tsx')).toContain('accessibilityLabel={`${value}, ${caption}`}');
  });
});
