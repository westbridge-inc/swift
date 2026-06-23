import { useId } from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';

/**
 * A dark gradient scrim for photo cards — keeps white text/badges legible over
 * imagery without banding. True gradient (react-native-svg, already in the
 * native build), so no new native module / rebuild. Anchored to an edge of its
 * parent; size it with `height` (bottom) or pass `cover` for a full overlay.
 */
export function Scrim({
  height = 96,
  from = 'rgba(0,0,0,0)',
  to = 'rgba(0,0,0,0.72)',
  cover = false,
  style,
}: {
  height?: number;
  from?: string;
  to?: string;
  cover?: boolean;
  style?: ViewStyle;
}) {
  // Unique per instance — ids are scoped per <Svg> on native, but useId keeps it
  // clean and future-proof.
  const id = useId();
  const pos: ViewStyle = cover
    ? { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }
    : { position: 'absolute', left: 0, right: 0, bottom: 0, height };
  return (
    <View pointerEvents="none" style={[pos, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
