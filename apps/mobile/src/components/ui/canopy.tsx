import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { color } from '@swift/ui';

/**
 * Kit-treatment gradient fill — a vertical colour ramp built from stacked
 * slices (NO svg: react-native-svg LinearGradient url(#) refs render SOLID
 * BLACK on the new architecture, and expo-linear-gradient would need a new
 * prebuild). 24 eased slices read smooth at masthead sizes.
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const SLICES = 24;

export function BrandGradient({
  from = color.masthead.from,
  to = color.masthead.to,
  style,
}: {
  from?: string;
  to?: string;
  style?: ViewStyle;
}) {
  const [r0, g0, b0] = hexToRgb(from);
  const [r1, g1, b1] = hexToRgb(to);
  return (
    <View style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }, style]}>
      {Array.from({ length: SLICES }, (_, i) => {
        const t = (i + 1) / SLICES;
        const eased = t * (2 - t); // ease-out: lighter top settles into the deep base
        const r = Math.round(r0 + (r1 - r0) * eased);
        const g = Math.round(g0 + (g1 - g0) * eased);
        const b = Math.round(b0 + (b1 - b0) * eased);
        return <View key={i} style={{ flex: 1, backgroundColor: `rgb(${r},${g},${b})` }} />;
      })}
    </View>
  );
}

/**
 * The canopy — Swift's masthead surface, kit treatment: a warm brand gradient
 * (brand-400 → brand-700) under the content, rounded bottom. Screens compose
 * their own content inside; spacing/radius are inline on purpose: Metro's
 * NativeWind cache can serve newly-introduced numeric utilities as zero, and
 * the masthead is too load-bearing to risk.
 */
export function Canopy({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          borderBottomLeftRadius: 28,
          borderBottomRightRadius: 28,
          overflow: 'hidden',
          backgroundColor: color.brand[600], // paints radius corners while slices mount
          zIndex: 2, // stays above the sheet that tucks under its rounded corners
        },
        style,
      ]}
    >
      <BrandGradient />
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 }}>{children}</View>
    </View>
  );
}
