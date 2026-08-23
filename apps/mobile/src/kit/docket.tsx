/** ⚠️ FOUNDER VETO 2026-08-22 — DO NOT RENDER THESE.
 * The toothed-edge family (awning scallop, receipt teeth, docket teeth) was
 * vetoed on sight: "this sucks, especially the bump under the search bar",
 * then again on Activity's sawtooth. Every render site has been removed;
 * mastheads end in the kit's clean 28dp curve. These components remain only
 * until the orphan sweep deletes them. */
import React from 'react';
import { View, useWindowDimensions, type ViewProps } from 'react-native';
import Svg, { Rect, Circle, Path } from 'react-native-svg';
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

/**
 * The receipt tear [design-100x Part 10, ACTIVITY signature]. A till slip
 * ends in torn triangular teeth — the activity masthead ends the same way,
 * closing the ledger of orders and rides. Distinct from AwningEdge (shop
 * scallops) and DocketEdge (kitchen punch-holes) in the commerce-edges family.
 */
export function ReceiptEdge({
  fill = color.masthead.to,
  toothWidth = 14,
  amplitude = 7,
  style,
  ...rest
}: ViewProps & { fill?: string; toothWidth?: number; amplitude?: number }) {
  const { width } = useWindowDimensions();
  const teeth = Math.max(4, Math.ceil(width / toothWidth));
  const tw = width / teeth;
  let d = `M0 0 H${width} `;
  for (let i = teeth; i > 0; i -= 1) {
    d += `L${(i - 0.5) * tw} ${amplitude} L${(i - 1) * tw} 0 `;
  }
  d += 'Z';
  return (
    <View pointerEvents="none" style={style} {...rest}>
      <Svg width={width} height={amplitude} viewBox={`0 0 ${width} ${amplitude}`}>
        <Path d={d} fill={fill} />
      </Svg>
    </View>
  );
}
