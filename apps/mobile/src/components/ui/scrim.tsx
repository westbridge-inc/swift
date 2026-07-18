import { View, type ViewStyle } from 'react-native';

/**
 * A dark gradient scrim for photo cards — keeps white text/badges legible over
 * imagery. Implemented as stacked opacity slices (NO svg): react-native-svg
 * LinearGradient url(#) refs render SOLID BLACK on the new architecture, which
 * silently turned every scrim into a block. 12 slices with eased alpha read as
 * a smooth gradient at card sizes. Anchored to the bottom edge by default
 * (`anchor="top"` flips it — dark at the top, for status-bar/back-button
 * legibility over hero photos); size with `height`, or pass `cover` for a
 * full overlay.
 */
const SLICES = 12;

function alphaOf(rgba: string): number {
  const m = rgba.match(/rgba?\([^,]+,[^,]+,[^,]+,?\s*([0-9.]+)?\)/);
  return m?.[1] != null ? Number(m[1]) : 1;
}

export function Scrim({
  height = 96,
  from = 'rgba(0,0,0,0)',
  to = 'rgba(0,0,0,0.72)',
  cover = false,
  anchor = 'bottom',
  style,
}: {
  height?: number;
  from?: string;
  to?: string;
  cover?: boolean;
  anchor?: 'bottom' | 'top';
  style?: ViewStyle;
}) {
  const a0 = alphaOf(from);
  const a1 = alphaOf(to);
  const top = anchor === 'top';
  const pos: ViewStyle = cover
    ? { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }
    : top
      ? { position: 'absolute', left: 0, right: 0, top: 0, height }
      : { position: 'absolute', left: 0, right: 0, bottom: 0, height };
  return (
    <View style={[pos, { pointerEvents: 'none' }, style]}>
      {Array.from({ length: SLICES }, (_, i) => {
        // `to` is always the dark end, at the anchored edge.
        const t = top ? 1 - i / SLICES : (i + 1) / SLICES;
        const eased = t * t; // ease-in reads closer to a real photo scrim
        const alpha = a0 + (a1 - a0) * eased;
        return (
          <View
            key={i}
            style={{ flex: 1, backgroundColor: `rgba(10,11,15,${alpha.toFixed(3)})` }}
          />
        );
      })}
    </View>
  );
}
