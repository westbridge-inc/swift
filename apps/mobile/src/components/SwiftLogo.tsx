import Svg, { G, Path } from 'react-native-svg';
import { color } from '@swift/ui';

/**
 * The Swift mark — a swift in flight. Vector, so it scales crisp at any size and
 * recolours for light/dark surfaces. Default is the two-tone red brand mark; pass
 * `tint`/`accent` (e.g. white) for a reversed mark on a red surface.
 */
export function SwiftMark({
  size = 40,
  tint,
  accent,
}: {
  size?: number;
  tint?: string;
  accent?: string;
}) {
  const primary = tint ?? color.brand[500];
  const secondary = accent ?? color.brand[600];
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <G transform="translate(-1.5,-6)">
        <Path
          d="M97 20 C76 30 60 40 50 52 C44 44 30 36 6 36 C26 42 38 52 44 64 C40 74 34 82 28 92 C42 80 50 70 54 60 C62 56 76 46 97 20 Z"
          fill={primary}
        />
        <Path d="M50 52 C62 56 76 46 97 20 C76 30 60 40 50 52 Z" fill={secondary} />
      </G>
    </Svg>
  );
}
