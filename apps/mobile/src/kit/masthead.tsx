/** @jsxImportSource react */
import React from 'react';
import { StyleSheet, View, useWindowDimensions, type ViewProps } from 'react-native';
import Svg, { Path } from 'react-native-svg';
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
    <View style={[{ overflow: 'hidden' }, style]} {...rest}>
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

/**
 * The awning hem [design-100x Part 10, HOME signature]. Georgetown commerce
 * happens under storefront awnings — the `shops` pictogram already draws one —
 * so the masthead ends the way a shopfront does: a shallow scalloped hem, one
 * colour (the wash's end), everything under it reading as the shelf below the
 * awning. Drawn once here so any masthead can inherit the shape.
 */
export function AwningEdge({
  fill = color.masthead.to,
  scallops = 9,
  amplitude = 8,
  style,
  ...rest
}: ViewProps & { fill?: string; scallops?: number; amplitude?: number }) {
  const { width } = useWindowDimensions();
  const sw = width / scallops;
  let d = `M0 0 H${width}`;
  for (let i = 0; i < scallops; i += 1) {
    d += ` a ${sw / 2} ${amplitude} 0 0 1 ${-sw} 0`;
  }
  d += ' Z';
  return (
    <View pointerEvents="none" style={style} {...rest}>
      <Svg width={width} height={amplitude} viewBox={`0 0 ${width} ${amplitude}`}>
        <Path d={d} fill={fill} />
      </Svg>
    </View>
  );
}
