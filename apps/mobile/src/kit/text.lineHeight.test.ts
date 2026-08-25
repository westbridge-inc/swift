import { describe, it, expect, vi } from 'vitest';
import { typeScale } from '@swift/ui';
import { scaleLineHeight } from './text-scale';

// text.tsx is JSX and this suite runs in a node environment — the arithmetic
// lives in text-scale.ts precisely so it stays testable without React Native.
// The exhaustiveness check at the bottom does need the real VARIANT keys
// though, so stub the native surface rather than move the map out of the
// component that owns it.
vi.mock('react-native', () => ({
  StyleSheet: { flatten: (s: unknown) => s },
  Text: 'Text',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));

import { TYPE_VARIANTS } from './text';

// [F-241] Every type token carries an ABSOLUTE lineHeight. React Native scales
// fontSize by the OS font scale but leaves a style-declared lineHeight alone,
// so without this the glyphs grow inside a fixed box and clip — worst on
// displayXl, which carries the OTP digits, the pickup code and hero money.
describe('type scale survives Dynamic Type [F-241]', () => {
  it('is a no-op at the default font scale (no layout change ships with the fix)', () => {
    for (const [name, style] of Object.entries(typeScale)) {
      expect(scaleLineHeight(style as never, 1), name).toBe(style);
    }
  });

  it('grows the line box by the same factor as the glyphs, so the ratio holds', () => {
    for (const scale of [1.15, 1.3, 2]) {
      for (const [name, style] of Object.entries(typeScale)) {
        const base = style as { fontSize: number; lineHeight?: number };
        if (!base.lineHeight) continue;
        const out = scaleLineHeight(style as never, scale) as { lineHeight: number };
        // The designed leading ratio is preserved exactly at every setting.
        expect(out.lineHeight / (base.fontSize * scale), `${name}@${scale}`)
          .toBeCloseTo(base.lineHeight / base.fontSize, 10);
      }
    }
  });

  it('leaves the glyphs to the OS — fontSize is never touched', () => {
    const out = scaleLineHeight(typeScale.body as never, 1.3) as { fontSize: number };
    expect(out.fontSize).toBe((typeScale.body as { fontSize: number }).fontSize);
  });

  it('the case that clipped: displayXl at 1.3 no longer laid into its 1x box', () => {
    const base = typeScale.displayXl as { fontSize: number; lineHeight: number };
    const scaled = scaleLineHeight(typeScale.displayXl as never, 1.3) as { lineHeight: number };
    // The OS renders glyphs at fontSize * scale; the box must cover them.
    expect(base.lineHeight).toBeLessThan(base.fontSize * 1.3); // the old bug
    expect(scaled.lineHeight).toBeGreaterThan(base.fontSize * 1.3); // fixed
  });
});

// ---------------------------------------------------------------------------
// EXHAUSTIVENESS. The type scale is written out by hand in four separate
// places, and kit/text.tsx is the copy whose omission fails loudest: a step
// present in tokens.ts but missing from VARIANT is looked up as `undefined`,
// and scaleLineHeight then dereferences `.lineHeight` on it — a TypeError at
// render, not a fallback.
//
// The `Record<keyof typeof typeScale, TextStyle>` annotation makes that a
// build error. This is the runtime half, so the rule survives someone
// widening the annotation back to `Record<string, …>` — which is exactly what
// it was, and why `<T variant="anythingAtAll">` type-checked.
// ---------------------------------------------------------------------------
describe('every type step is renderable', () => {
  it('VARIANT covers typeScale exactly — no step without a variant, no variant without a step', () => {
    expect([...TYPE_VARIANTS].sort()).toEqual(Object.keys(typeScale).sort());
  });

  it('every variant carries an absolute lineHeight, so scaleLineHeight can do its job', () => {
    for (const name of TYPE_VARIANTS) {
      const step = typeScale[name] as { lineHeight?: number };
      expect(step.lineHeight, `${name} has no lineHeight — Dynamic Type would clip it`).toBeTypeOf('number');
    }
  });
});
