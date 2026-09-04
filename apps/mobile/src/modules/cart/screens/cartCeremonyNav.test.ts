import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// P0 (founder, 08-30): after placing an order — pickup or delivery — the whole
// tracking screen ate every tap, back chevron included.
//
// Cause: the order-placed ceremony is a windowed RN Modal, and both of its
// exits called placeOrder.reset() and navigation.navigate() in the SAME tick.
// Dismissing a Modal in the same frame a navigation transition starts is the
// classic React Native wedge: the Modal's native window can survive the race
// invisibly and swallow every touch on the screen underneath.
//
// The law this file pins: the ceremony's exits may only STAGE the navigation;
// the actual navigate happens in an effect strictly AFTER isSuccess has
// flushed false, a frame later, when the Modal window is provably gone.
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/modules/cart/screens/CartScreen.tsx');

function stripComments(src: string): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (out.trim().length < 1000) throw new Error('comment stripper emptied the file — assertions would be vacuous');
  return out;
}

describe('order-placed ceremony — dismiss first, navigate after', () => {
  const src = stripComments(readFileSync(FILE, 'utf8'));

  it('no handler resets the ceremony and navigates in the same tick', () => {
    // The wedge shape: reset() followed by an immediate navigate in one
    // handler body. Zero occurrences may exist.
    expect(src).not.toMatch(/placeOrder\.reset\(\);\s*\n?\s*if \([^)]*\) navigation\.navigate\(/);
    expect(src).not.toMatch(/placeOrder\.reset\(\);\s*\n?\s*navigation\.navigate\(/);
  });

  it('the exits stage the navigation instead', () => {
    expect((src.match(/setPendingTrackId\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // decl + 2 exits (+ effect clear)
  });

  it('the deferred effect navigates only after the modal state has flushed false, one frame later', () => {
    expect(src).toMatch(/if \(placeOrder\.isSuccess \|\| !pendingTrackId\) return;/);
    // The ceremony now navigates from the modal's OWN post-dismissal callback —
    // the only signal that means "the native window is gone" — with a
    // two-frame deferral as the fallback. The previous assertion named
    // InteractionManager, which RN 0.85 hollowed out into a `setImmediate`.
    expect(src).toContain('onDismissed');
    expect(src).toMatch(/requestAnimationFrame\([\s\S]{0,200}navigation\.navigate\('Delivery'/);
    expect(src).toContain('cancelAnimationFrame');
  });
});
