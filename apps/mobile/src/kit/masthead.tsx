/** @jsxImportSource react */
import React from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { color } from '@swift/ui';

// Vertical gradient via stacked solid slices. react-native-svg gradients render
// black under the new architecture and expo-linear-gradient needs a prebuild,
// so the masthead wash is interpolated in plain Views — invisible at 28 steps.
function lerpChannel(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

function lerpHex(from: string, to: string, t: number): string {
  const f = from.replace('#', '');
  const g = to.replace('#', '');
  const rgb = [0, 2, 4].map((i) =>
    lerpChannel(parseInt(f.slice(i, i + 2), 16), parseInt(g.slice(i, i + 2), 16), t),
  );
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Brand masthead wash (brand 500 → 600), children on top. */
export function GradientMasthead({
  children,
  style,
  slices = 28,
  ...rest
}: ViewProps & { slices?: number }) {
  const { from, to } = color.masthead;
  return (
    // [FOUNDER VETO 08-22] The awning scallop that used to close this panel is
    // gone — "the bump under the search bar". The masthead now ends in a clean
    // 28dp curve: one quiet, premium edge instead of a row of teeth.
    <View style={[{ overflow: 'hidden', borderBottomLeftRadius: 28, borderBottomRightRadius: 28 }, style]} {...rest}>
      <View style={StyleSheet.absoluteFill}>
        {Array.from({ length: slices }, (_, i) => (
          <View
            key={i}
            style={{ flex: 1, backgroundColor: lerpHex(from, to, slices === 1 ? 0 : i / (slices - 1)) }}
          />
        ))}
      </View>
      {children}
    </View>
  );
}

// [FOUNDER VETO 2026-08-22] AwningEdge (the scalloped awning hem) lived here.
// The toothed-edge family — awning scallops, docket punch-holes, receipt
// teeth — was vetoed outright, and an exported vetoed component is an
// invitation: it sat first in autocomplete for anyone reaching for a masthead
// finish. Deleted with docket.tsx in the DRIFT-08 cleanup; the masthead ends
// flat, exactly as every shipped screen already renders it.
