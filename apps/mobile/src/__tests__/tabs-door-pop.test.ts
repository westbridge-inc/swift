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

// [REVIEW-F #1901 S4-1] Every way a door can be written, not only the
// positional call: navigate('Tabs', …), navigate({ name: 'Tabs', … }),
// CommonActions.navigate(…) inside dispatch(…), push('Tabs') and
// StackActions.push('Tabs'). A call's arguments are read to its balanced
// closing parenthesis, so nested params ({ screen: 'Cart' }) cannot hide a
// missing pop.
type Door = { verb: 'navigate' | 'push'; args: string };
function doorsToTabs(src: string): Door[] {
  const doors: Door[] = [];
  for (const m of src.matchAll(/\b(navigate|push)\??\.?\(/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    const args = src.slice(start, i - 1);
    if (/^\s*['"]Tabs['"]/.test(args) || /^\s*\{[\s\S]*?\bname:\s*['"]Tabs['"]/.test(args)) doors.push({ verb: m[1] as Door['verb'], args });
  }
  return doors;
}
/** A door goes BACK to the tab bar only as a navigate that carries pop: true. */
const goesBack = (door: Door) => door.verb === 'navigate' && /\bpop:\s*true\b/.test(door.args);

describe('[UI-SWEEP U09] every door to the customer Tabs goes back to them', () => {
  const calls = sources(SRC).flatMap((file) =>
    doorsToTabs(stripComments(readFileSync(file, 'utf8'))).map((door) => ({ file: relative(SRC, file), door })));

  it('finds the known doors (the census is not vacuous)', () => {
    const files = new Set(calls.map((c) => c.file));
    for (const f of ['kit/cart-bar.tsx', 'modules/shop/screens/MenuItemScreen.tsx', 'modules/orders/screens/OrdersHistoryScreen.tsx']) {
      expect(files.has(f), f).toBe(true);
    }
  });

  it('sees every form a door can be written in (the reader is not blind)', () => {
    const pushesASecondTabBar = [
      "navigation.navigate('Tabs', { screen: 'Cart' })",
      "navigation.navigate({ name: 'Tabs', params: { screen: 'Cart' } })",
      "navigation.dispatch(CommonActions.navigate({ name: 'Tabs', params: { screen: 'Orders' } }))",
      "navigation.dispatch(CommonActions.navigate('Tabs', { screen: 'Orders' }))",
      "navigation.push('Tabs', { screen: 'Cart' }, { pop: true })",
      "navigation.dispatch(StackActions.push('Tabs'))",
      "nav?.navigate?.('Tabs')",
    ];
    for (const snippet of pushesASecondTabBar) {
      const doors = doorsToTabs(snippet);
      expect(doors.length, snippet).toBe(1);
      expect(goesBack(doors[0]!), snippet).toBe(false);
    }
    const goBackToIt = [
      "navigation.navigate('Tabs', { screen: 'Cart' }, { pop: true })",
      "navigation.navigate('Tabs', { screen: tabFor(order) }, { pop: true })",
      "navigation.navigate({ name: 'Tabs', params: { screen: 'Cart', params: { from: 'x' } }, pop: true })",
      "navigation.dispatch(CommonActions.navigate({ name: 'Tabs', params: { screen: 'Orders' }, pop: true }))",
    ];
    for (const snippet of goBackToIt) {
      const doors = doorsToTabs(snippet);
      expect(doors.length, snippet).toBe(1);
      expect(goesBack(doors[0]!), snippet).toBe(true);
    }
    expect(doorsToTabs("navigation.navigate('Cart'); navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] })")).toEqual([]);
  });

  it('no door to Tabs pushes a second tab bar', () => {
    const pushes = calls.filter((c) => !goesBack(c.door)).map((c) => `${c.file}: ${c.door.verb}(${c.door.args.replace(/\s+/g, ' ')})`);
    expect(pushes).toEqual([]);
  });
});
