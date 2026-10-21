import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [UI-SWEEP U09] `Tabs` is the root of the customer stack: a screen above it
// that calls navigate('Tabs', …) without { pop: true } PUSHES a second copy of
// the whole tab bar (React Navigation 7 changed navigate; kit/cart-bar.navigation
// .test.ts shows the stack growing on the real router). Every door to Tabs
// therefore goes BACK to it. This census fails on any call that does not.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// navigate('Tabs' … up to the call's closing parenthesis (params hold no parentheses at these sites).
const CALL = /navigate\??\.?\(\s*['"]Tabs['"][^)]*\)/g;

describe('[UI-SWEEP U09] every door to the customer Tabs goes back to them', () => {
  const calls = sources(SRC).flatMap((file) =>
    [...stripComments(readFileSync(file, 'utf8')).matchAll(CALL)].map((m) => ({ file: relative(SRC, file), call: m[0] })));

  it('finds the known doors (the census is not vacuous)', () => {
    const files = new Set(calls.map((c) => c.file));
    for (const f of ['kit/cart-bar.tsx', 'modules/shop/screens/MenuItemScreen.tsx', 'modules/orders/screens/OrdersHistoryScreen.tsx']) {
      expect(files.has(f), f).toBe(true);
    }
  });

  it('no navigate(\'Tabs\', …) pushes a second tab bar', () => {
    const pushes = calls.filter((c) => !/\{\s*pop:\s*true\s*\}\s*\)$/.test(c.call));
    expect(pushes).toEqual([]);
  });
});
