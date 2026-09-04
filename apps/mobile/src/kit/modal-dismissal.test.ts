import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [P0 · frozen screen] Never navigate on a guess about the modal.
//
// The founder's original P0: dismissing a windowed Modal in the same tick a
// navigation starts lets the modal's NATIVE WINDOW survive invisibly above the
// destination screen, eating every touch. The tracking screen went dead after
// ordering.
//
// The fix at the time was `InteractionManager.runAfterInteractions`. React
// Native 0.85 then replaced InteractionManager with `InteractionManagerStub`,
// whose `runAfterInteractions` is a bare `setImmediate`:
//
//     runAfterInteractions(task) { setImmediate(() => task()); }
//
// It waits for no interaction, no animation, and no window teardown. Nothing
// failed to compile. The call still returned a cancellable handle. The guard
// simply stopped guarding, silently, in a dependency bump — and the founder
// reported the same frozen screen again.
//
// This suite is the tripwire that class of regression needed and did not have.
// ---------------------------------------------------------------------------

const SRC = process.cwd().endsWith('apps/mobile')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'mobile', 'src');

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Comments discuss the old API by name on purpose; only code may call it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const DISMISSAL_SENSITIVE = [
  'kit/after-dismiss.ts',
  'kit/card.tsx',
  'modules/cart/screens/CartScreen.tsx',
];

describe('[P0] the modal-dismissal guard is a guard, not a stub', () => {
  it.each(DISMISSAL_SENSITIVE)('%s does not call InteractionManager', (rel) => {
    expect(
      /InteractionManager\s*\./.test(code(read(rel))),
      'InteractionManager is a STUB in React Native 0.85 — runAfterInteractions is a bare setImmediate that waits for nothing. ' +
        'Use PopupCard onDismissed (the real post-teardown signal) or a two-frame defer.',
    ).toBe(false);
  });

  it('PopupCard forwards a real post-dismissal callback to the native Modal', () => {
    const card = read('kit/card.tsx');
    expect(card).toContain('onDismissed');
    // It must reach the Modal itself — a prop the component swallows is worse
    // than no prop, because callers would navigate on a signal that never fires.
    expect(/onDismiss=\{onDismissed\}|onDismiss:\s*onDismissed/.test(card)).toBe(true);
  });

  it('afterDismiss actually defers — a bare call would be the stub with extra steps', () => {
    const seam = code(read('kit/after-dismiss.ts'));
    expect(seam).toMatch(/requestAnimationFrame/);
    // Two frames, not one: the first commits the removal, the second presents it.
    expect((seam.match(/requestAnimationFrame/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the cart ceremony navigates from the modal callback, not only from a timer', () => {
    const cart = read('modules/cart/screens/CartScreen.tsx');
    expect(cart).toContain('onDismissed');
    // ...and the fallback path still defers by frames rather than immediately.
    expect(code(cart)).toMatch(/requestAnimationFrame/);
  });

  it('every dismissal-sensitive file still cancels what it schedules', () => {
    // A scheduled navigation that outlives the screen navigates a dead stack.
    const cart = code(read('modules/cart/screens/CartScreen.tsx'));
    expect(cart).toMatch(/cancelAnimationFrame/);
  });
});
