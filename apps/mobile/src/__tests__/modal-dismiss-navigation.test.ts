import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  // [UI-SWEEP U04, U12] Trip complete -> Back; Request sent -> My jobs.
  { file: 'src/modules/mover/screens/ActiveJobScreen.tsx', afterDismissCalls: 1 },
  { file: 'src/modules/services/screens/ServicesScreen.tsx', afterDismissCalls: 1 },
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
    // This used to assert the API NAME — and that is exactly how the guard was
    // lost. React Native 0.85 replaced InteractionManager with a stub whose
    // `runAfterInteractions` is a bare `setImmediate`: the name this test
    // demanded survived the upgrade, the guarantee behind it did not, and the
    // frozen-screen P0 came back with the suite still green. Assert the
    // DEFERRAL, never the identifier.
    expect(seam).not.toMatch(/InteractionManager\s*\./);
    expect((seam.match(/requestAnimationFrame/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(seam).toMatch(/export function afterDismiss\(go: \(\) => void\): void/);
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U04, U12] The list above only guarded the files it named, and its
// shape missed optional chaining (`navigation?.goBack?.()`) and a popup closed
// by clearing its record (`setRatePopup(null)`): the driver's Trip complete
// popup and Services' Request sent both slipped through. This census reads
// EVERY source file. A same-tick close-then-navigate is allowed only where the
// navigation provably runs after the modal's teardown, and each such site
// names the proof that must stay in its file.
// ---------------------------------------------------------------------------

// [REVIEW-F #1903 S4-1] Wider than the literal pair: any close call
// (`setX(false|null|undefined)`, or another name such as `hide(false)`), up
// to two plain statements in between (no block boundary), and any navigation
// receiver: `navigation`, an alias (`nav`, `navigationRef`), a destructured
// `navigate(…)`, or `safeNavigate(…)`.
const CLOSE = String.raw`\b[A-Za-z_$][\w$]*\((?:false|null|undefined)\);`;
const BETWEEN = String.raw`(?:[ \t]*\n?[ \t]*[^\n{}]*?;){0,2}`;
const NAVIGATES = String.raw`[ \t]*\n?[ \t]*(?:\b[A-Za-z_$][\w$]*\??\.)?(?:navigate|goBack|replace|popToTop|popTo|push|pop|dispatch|safeNavigate)\??\.?\(`;
const WIDE = new RegExp(CLOSE + BETWEEN + NAVIGATES, 'g');

const AFTER_TEARDOWN: Array<{ file: string; setter: string; why: string; proof: RegExp[] }> = [
  {
    file: 'modules/mover/screens/ActiveJobScreen.tsx',
    setter: 'setDriverHandbackFlow(null)',
    why: 'finishDriverHandbackDismissal runs from the popup\'s onDismissed (iOS) or two frames after it hid (elsewhere)',
    proof: [/onDismissed=\{finishDriverHandbackDismissal\}/, /requestAnimationFrame\(finishDriverHandbackDismissal\)/, /phase !== 'dismissing'/],
  },
  {
    file: 'modules/cart/screens/CartScreen.tsx',
    setter: 'setPendingTrackId(null)',
    why: 'the order-placed ceremony clears its staged id inside the second animation frame (cartCeremonyNav.test.ts)',
    proof: [/raf2 = requestAnimationFrame\(\(\) => \{\s*setPendingTrackId\(null\)/],
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('[UI-SWEEP U04, U12] no source file closes a popup and navigates in the same tick', () => {
  const SRC = join(process.cwd(), 'src');
  const files = sourceFiles(SRC);
  const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const hits = files.flatMap((file) => [...code(file).matchAll(WIDE)].map((m) => ({ file: relative(SRC, file), shape: m[0].replace(/\s+/g, ' ') })));

  it('reads the whole app, and sees the sites it allows (the census is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(300);
    for (const site of AFTER_TEARDOWN) {
      expect(hits.some((h) => h.file === site.file && h.shape.startsWith(site.setter)), `${site.file} ${site.setter}`).toBe(true);
    }
  });

  it('sees every way the wedge can be written (the reader is not blind)', () => {
    const wedges = [
      "setOpen(false);\n    navigation.navigate('Orders');",
      "setOpen(false);\n    nav.goBack();",
      "setRatePopup(null);\n    navigationRef.navigate('Delivery', { orderId });",
      "setOpen(false);\n    toast.success('Saved');\n    navigation.goBack();",
      "setOpen(false); track('closed'); navigate('Orders');",
      "hidePopup(false);\n    navigation?.replace?.('Home');",
      "setSheet(undefined);\n    safeNavigate('WeeklyFee');",
    ];
    for (const snippet of wedges) expect([...snippet.matchAll(WIDE)].length, snippet).toBe(1);
    const notTheWedge = [
      // the deferral seam itself
      "setOpen(false);\n    afterDismiss(() => navigation.navigate('Orders'));",
      // a different handler: the block boundary ends the window
      "setOpen(false);\n  }}\n  onPress={() => navigation.goBack()}",
    ];
    for (const snippet of notTheWedge) expect([...snippet.matchAll(WIDE)], snippet).toEqual([]);
    // The window is two statements; a longer handler is left to review.
    expect([..."setOpen(false);\n    a();\n    b();\n    c();\n    navigation.goBack();".matchAll(WIDE)]).toEqual([]);
  });

  it('every same-tick close-then-navigate is one of the sites proven to run after the teardown', () => {
    const unproven = hits.filter((h) => !AFTER_TEARDOWN.some((site) => site.file === h.file && h.shape.startsWith(site.setter)));
    expect(unproven).toEqual([]);
  });

  for (const site of AFTER_TEARDOWN) {
    it(`${site.file}: ${site.why}`, () => {
      const src = code(join(SRC, site.file));
      for (const proof of site.proof) expect(src).toMatch(proof);
    });
  }
});
