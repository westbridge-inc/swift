import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [R3] VendorStack.tsx is a router, and stays one.
//
// It was 4,965 lines: 31 routes, six whole screens defined inline, and a
// 19-line stub at the canonical path for one of them that nothing imported
// (R2). A session told to rebuild a vendor screen would open the obvious file,
// do good work, go green, and ship nothing — the routed definition was the
// inline one, three thousand lines into the navigator.
//
// The split moved every screen out byte-for-byte. This pins the shape so it
// cannot silently grow back: the router holds navigators and the glue that
// decides which of them to show, and every screen it routes is imported.
// ---------------------------------------------------------------------------

const SRC = readFileSync(new URL('./VendorStack.tsx', import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const CODE = strip(SRC);

describe('VendorStack.tsx is a router', () => {
  it('stays under 400 lines', () => {
    expect(SRC.split('\n').length).toBeLessThan(400);
  });

  it('defines no screen inline — a screen lives in screens/ where the next session will look', () => {
    const inline = [...CODE.matchAll(/^(?:export )?(?:function|const)\s+(\w+Screen)\b/gm)].map((m) => m[1]);
    expect(inline).toEqual([]);
  });

  it('every routed component is imported, not declared here — except the navigator glue', () => {
    // These are navigation, not screens: the root switch (setup / suspended /
    // tabs), the tab bar, the nested menu stack, and the two always-mounted
    // store layers. They belong to the router.
    const GLUE = new Set(['VendorRoot', 'VendorTabs', 'MenuStackNav', 'VendorOrdersTab']);
    const imported = new Set([...CODE.matchAll(/import\s*\{([^}]+)\}\s*from/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, '').replace(/^\w+\s+as\s+/, '')).filter(Boolean)));
    const routed = [...CODE.matchAll(/component=\{(\w+)\}/g)].map((m) => m[1]!);
    expect(routed.length).toBeGreaterThan(10);
    const declaredHere = routed.filter((c) => !GLUE.has(c) && !imported.has(c));
    expect(declaredHere, 'a routed component defined inside the router').toEqual([]);
  });
});
