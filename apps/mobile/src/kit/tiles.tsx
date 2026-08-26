import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Card } from './card';
import { Eyebrow } from './labels';
import { Pictogram, type PictogramName } from './pictograms';
import { T } from './text';

// ---------------------------------------------------------------------------
// [Wave 3] The two tile shapes every dashboard and list row leans on.
// ---------------------------------------------------------------------------

/**
 * IconTile — the blush rounded square holding a pictogram; the anchor mark on
 * list rows and launcher tiles. House pictograms only — never glyph-font
 * clipart, never emoji. `tint` swaps the ground/ink pair for a vertical
 * identity (vertical-tint.ts); default is the brand blush.
 */
export function IconTile({
  name,
  size = 48,
  tint,
  style,
}: {
  name: PictogramName;
  /** Outer square edge; the pictogram scales at half the edge. */
  size?: number;
  tint?: { bg: string; ink: string };
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius.lg,
          backgroundColor: tint?.bg ?? color.brand[50],
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Pictogram name={name} size={Math.round(size / 2)} color={tint?.ink ?? color.brand[600]} />
    </View>
  );
}

/**
 * StatTile — eyebrow + the number + a sub line, used in twos and threes on
 * every dashboard. The number rides the display face with tabular figures
 * (`numL`), because a stat that jitters as it updates reads as a lie about
 * precision. `value` accepts a node so <Money> can carry the figure.
 */
export function StatTile({
  label,
  value,
  sub,
  size = 'lg',
  style,
}: {
  /** The eyebrow — FACTUAL ("EARNED TODAY", "JOBS"), never decoration. */
  label: string;
  value: ReactNode;
  sub?: string;
  /** 'lg' (numL) for dashboard hero stats; 'md' (numM) for dense triads. */
  size?: 'lg' | 'md';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card style={[{ flex: 1, paddingVertical: space.md }, style]}>
      <Eyebrow>{label}</Eyebrow>
      {typeof value === 'string' || typeof value === 'number' ? (
        <T variant={size === 'md' ? 'numM' : 'numL'} numberOfLines={1} style={{ marginTop: 2 }}>
          {value}
        </T>
      ) : (
        <View style={{ marginTop: 2 }}>{value}</View>
      )}
      {sub ? (
        <T variant="caption" tone="muted" style={{ marginTop: 2 }} numberOfLines={1}>
          {sub}
        </T>
      ) : null}
    </Card>
  );
}
