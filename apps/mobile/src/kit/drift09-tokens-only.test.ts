import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [DRIFT-09] The ported primitives are TOKEN-ONLY, by test. Every rebuild
// rule the drift register carries, enforced where it can't be forgotten:
//  - no NativeWind `className` styling (the kit styles through tokens+style),
//  - no raw hex colours (palette lives in @swift/ui alone),
//  - no reaching back into the legacy folder (that is the contamination this
//    port exists to end).
// Structural geometry literals (a 4pt bar, the masthead's 28pt radius) are
// allowed and documented in-file; COLOUR and CLASSNAME are the drift vectors.
// ---------------------------------------------------------------------------

const KIT = process.cwd().endsWith('apps/mobile') ? join(process.cwd(), 'src', 'kit') : join(process.cwd(), 'apps', 'mobile', 'src', 'kit');

const PORTED = [
  'toast.tsx',
  'toast-duration.ts',
  'action-sheet.tsx',
  'confirm-dialog.tsx',
  'step-progress.tsx',
  'avatar.tsx',
  'badge.tsx',
  'canopy.tsx',
  'choice-chip.tsx',
  'pressable-scale.tsx',
  'scrim.tsx',
  'image.tsx',
  // [Wave 3] The composite primitives ride the same three laws.
  'labels.tsx',
  'tiles.tsx',
  'dock.tsx',
  'segmented.tsx',
  'receipt-bill.tsx',
  'map-peek.tsx',
  // [Wave 3 part 2] Promotions from host screens.
  'fare-slider.tsx',
  'fare-step.ts',
  'hold-ring.tsx',
  'hold-window.ts',
  'calm-radar.tsx',
] as const;

describe('DRIFT-09 ports are token-only', () => {
  for (const file of PORTED) {
    const source = readFileSync(join(KIT, file), 'utf8');

    it(`${file} carries no className styling`, () => {
      // The hazard is a component ACCEPTING or SETTING className — a prop
      // declaration (`className?:`) or a JSX/object assignment (`className=`,
      // `className:`). Prose in comments may name the word; code may not.
      const uses = source.match(/\bclassName\??\s*[:=]/g) ?? [];
      expect(uses, `${file} styles through tokens and style, never className`).toEqual([]);
    });

    it(`${file} carries no raw hex colour`, () => {
      // Colour literals live in @swift/ui only. (#-anchored 3/6/8-digit hex.)
      const hexes = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `${file} must take every colour from tokens — found ${hexes.join(', ')}`).toEqual([]);
    });

    it(`${file} never imports from the legacy folder`, () => {
      // The hazard is an IMPORT, not the phrase — the ports' own doc comments
      // rightly name where they came from.
      const imports = source.match(/from\s+['"][^'"]*components\/ui/g) ?? [];
      expect(imports, `${file} reaches into components/ui`).toEqual([]);
    });
  }

  it('the vetoed toothed-edge family is gone from the kit', () => {
    const index = readFileSync(join(KIT, 'index.ts'), 'utf8');
    for (const name of ['DocketEdge', 'ReceiptEdge', 'AwningEdge']) {
      expect(index.includes(`export { ${name}`), `${name} must not be exported`).toBe(false);
    }
    const masthead = readFileSync(join(KIT, 'masthead.tsx'), 'utf8');
    expect(masthead.includes('export function AwningEdge'), 'AwningEdge must stay deleted').toBe(false);
  });
});
