import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [#910's law, generalized] Dismissing a windowed Modal in the SAME TICK a
// navigation starts can leave the Modal's invisible native window floating
// above the destination, eating every touch — the founder's frozen-screen P0.
//
// The sweep that followed #910 found the same shape on four more ceremonies:
// added-to-cart → View cart, order-arrived → Rate this order, the vendor
// share popup's two doors, and the feedback thanks popup. All now route the
// navigation through ONE seam, kit/after-dismiss.ts, which defers it past
// the modal teardown.
//
// This file pins both halves: the banned adjacent shape may not return to
// these files, and the seam itself must stay a real deferral.
//
// (CartScreen keeps its own staged-effect variant — its modal is driven by
// mutation state, not a local boolean — pinned by cartCeremonyNav.test.ts.)
// ---------------------------------------------------------------------------

const CONVERTED: Array<{ file: string; afterDismissCalls: number }> = [
  { file: 'src/modules/vendor/screens/VendorOps.tsx', afterDismissCalls: 2 },
  { file: 'src/modules/orders/screens/FeedbackScreen.tsx', afterDismissCalls: 2 },
  { file: 'src/modules/shop/screens/MenuItemScreen.tsx', afterDismissCalls: 1 },
  { file: 'src/modules/orders/screens/DeliveryScreen.tsx', afterDismissCalls: 1 },
];

// The wedge shape: a modal-visibility setter to false, immediately followed
// (same or next line) by a navigation call in the same handler body.
const WEDGE = /set[A-Za-z]+\(false\);\s*\n?\s*navigation\.(navigate|goBack|replace|popToTop)\(/;

// min: the seam file is deliberately mostly law-comment — its stripped body is
// a handful of lines, so it carries its own, lower vacuity floor.
function stripComments(src: string, min = 500): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (out.trim().length < min) throw new Error('comment stripper emptied the file — assertions would be vacuous');
  return out;
}

describe('modal exits close in their own tick — navigation is deferred', () => {
  for (const { file, afterDismissCalls } of CONVERTED) {
    const src = stripComments(readFileSync(join(process.cwd(), file), 'utf8'));

    it(`${file} carries no same-tick dismiss-then-navigate`, () => {
      const hit = src.match(WEDGE);
      expect(hit, hit ? `wedge shape at: ${hit[0]}` : undefined).toBeNull();
    });

    it(`${file} routes its ceremony exits through afterDismiss (${afterDismissCalls})`, () => {
      expect((src.match(/afterDismiss\(\(\) =>/g) ?? []).length).toBeGreaterThanOrEqual(afterDismissCalls);
      expect(src).toContain("from '../../../kit/after-dismiss'");
    });
  }

  it('the seam is a real deferral, not a rename', () => {
    const seam = stripComments(readFileSync(join(process.cwd(), 'src/kit/after-dismiss.ts'), 'utf8'), 80);
    expect(seam).toContain('InteractionManager.runAfterInteractions(go)');
    expect(seam).toMatch(/export function afterDismiss\(go: \(\) => void\): void/);
  });
});
