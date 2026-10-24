import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [UI-SWEEP U32] A store, an item or a delivery that is still loading, or
// whose read failed, replaced the whole screen with a spinner or an error and
// no visible way back (swipe or the hardware button only). Every such
// early-return branch on these screens now carries the kit Header and its Back
// chip. (The item page's branches are driven in MenuItemScreen.gone.test.ts;
// BUG-GUARDS' C4 census covers the rest of the app.)
// ---------------------------------------------------------------------------

const BRANCHES: Array<{ file: string; opens: string[] }> = [
  { file: 'modules/shop/screens/RestaurantScreen.tsx', opens: ['if (vendor.isLoading) {', 'if (vendor.isError || !v) {'] },
  { file: 'modules/shop/screens/MenuItemScreen.tsx', opens: ['if (vendor.isLoading) {', 'if (vendor.isError || !item) {'] },
  { file: 'modules/orders/screens/DeliveryScreen.tsx', opens: ['if (order.isLoading) {', 'if (!o) {'] },
];

describe('[UI-SWEEP U32] loading and failure branches keep a way back', () => {
  for (const { file, opens } of BRANCHES) {
    const src = readFileSync(join(process.cwd(), 'src', file), 'utf8');
    for (const open of opens) {
      it(`${file}: \`${open}\` renders the kit Header`, () => {
        const at = src.indexOf(`\n  ${open}\n`);
        expect(at, `the branch \`${open}\` is a block that returns a screen`).toBeGreaterThan(-1);
        const block = src.slice(at, src.indexOf('\n  }\n', at));
        expect(block).toMatch(/return \(/);
        expect(block).toContain('<Header />');
      });
    }
  }
});
