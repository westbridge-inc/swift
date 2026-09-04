import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { color } from '@swift/ui';

// ---------------------------------------------------------------------------
// The palette's own two laws, made executable.
//
// Both of these shipped, both were invisible in review, and both were found by
// the founder opening the app rather than by anything in CI:
//
//   1. The document checklist's progress track was painted `surface.subtle` —
//      which the palette defines as "paper — the app background". A track the
//      same colour as the page it sits on cannot be seen, and at "0 of 5
//      approved" the viridian fill is 0% wide, so a new mover saw a caption
//      with nothing beneath it. The bar only became visible once you no longer
//      needed it.
//
//   2. "We need your location to pin your store" rendered in `error` — the
//      red the palette reserves for GENUINE FAILURE, deliberately hotter than
//      brand so a second red means something. Nothing had failed; a permission
//      simply had not been granted yet.
// ---------------------------------------------------------------------------

const SRC = process.cwd().endsWith('apps/mobile')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'mobile', 'src');

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('[palette] a track is never painted in the page it sits on', () => {
  it('the track ground and the page ground are different colours', () => {
    // Stated as a RELATIONSHIP, never as a literal. An earlier draft asserted
    // the paper colour by value and the UI Barrier rejected it — correctly: a
    // brand colour written out anywhere but packages/ui is how a second palette
    // starts, and the gate greps text, so a comment counts too. The law was
    // never about a specific colour. It is that a track cannot be the same
    // colour as the surface it sits on.
    expect(color.surface.sunken).not.toBe(color.surface.subtle);
  });

  it('the document progress track uses the sunken ground the palette names for tracks', () => {
    const src = code(read('components/onboarding/DocumentChecklist.tsx'));
    // The track is the View that sets TRACK_HEIGHT *and* a background — not the
    // constant's own declaration, which an earlier draft of this test matched.
    const track = (src.match(/height: TRACK_HEIGHT[^}]*backgroundColor:[^}]*/g) ?? []).join('\n');
    expect(track, 'no track View found').not.toBe('');
    expect(track).toContain('color.surface.sunken');
    expect(
      /backgroundColor:\s*color\.surface\.subtle/.test(track),
      'A progress track in the page\'s own colour is invisible at 0% — which is exactly when a user most needs to see that progress is being kept.',
    ).toBe(false);
  });
});

describe('[two-reds law] error red means failure, never an instruction', () => {
  // Brand is already red. A second red has to earn its meaning, so `error` is
  // reserved for genuine failure — and meaning is never carried by colour alone.
  it('error and brand are visibly different reds', () => {
    expect(color.error).not.toBe(color.brand[500]);
    expect(color.warning).not.toBe(color.error);
  });

  it('the store-location prompt is a caution, not a failure', () => {
    const src = code(read('modules/vendor/screens/BusinessSetup.tsx'));
    expect(src).toMatch(/tone=\{hasPin \? 'muted' : 'warning'\}/);
    expect(
      /tone=\{hasPin \? 'muted' : 'error'\}/.test(src),
      'Asking for a permission that was never granted is not a failure — the palette reserves error for that.',
    ).toBe(false);
  });

  // A ledger of every screen using error tone was drafted here and removed on
  // purpose: it listed 33 files, most of them reporting genuine failures (a
  // declined payment, a rejected document). A ratchet that fires on legitimate
  // use trains the next author to update the snapshot without reading it, which
  // buys false confidence rather than safety. The two laws above are specific,
  // and specificity is what makes a rule worth obeying.
});
