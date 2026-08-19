import React from 'react';
import { View, useWindowDimensions, type ViewProps } from 'react-native';
import Svg, { Rect, Circle } from 'react-native-svg';
import { color } from '@swift/ui';

/**
 * The docket tear-line [design-100x Part 10, VENDOR signature]. A Georgetown
 * kitchen runs on paper dockets on a rail — the order card ends the way a
 * docket does: a punched tear-off edge. Card-coloured strip, holes punched in
 * the page colour, so the queue reads as tickets waiting to be torn.
 */
export function DocketEdge({
  cardColor = color.surface.base,
  holeColor = color.surface.subtle,
  amplitude = 6,
  holeRadius = 2.5,
  spacing = 14,
  inset = 0,
  style,
  ...rest
}: ViewProps & {
  cardColor?: string;
  holeColor?: string;
  amplitude?: number;
  holeRadius?: number;
  spacing?: number;
  /** Horizontal gutters the parent applies (so hole spacing stays honest). */
  inset?: number;
}) {
  const { width } = useWindowDimensions();
  const w = Math.max(0, width - inset * 2);
  const holes = Math.max(3, Math.floor(w / spacing));
  const step = w / holes;
  return (
    <View pointerEvents="none" style={style} {...rest}>
      <Svg width={w} height={amplitude} viewBox={`0 0 ${w} ${amplitude}`}>
        <Rect x={0} y={0} width={w} height={amplitude} fill={cardColor} />
        {Array.from({ length: holes }, (_, i) => (
          <Circle key={i} cx={i * step + step / 2} cy={amplitude} r={holeRadius} fill={holeColor} />
        ))}
      </Svg>
    </View>
  );
}
