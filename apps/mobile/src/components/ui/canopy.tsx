import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { color } from '@swift/ui';

/**
 * The crimson canopy — Swift's masthead surface (deep brand-700, rounded
 * bottom). Screens compose their own content inside; spacing/radius are
 * inline on purpose: Metro's NativeWind cache can serve newly-introduced
 * numeric utilities as zero, and the masthead is too load-bearing to risk.
 * Keep it compact: dark red reads premium in small doses, queasy in floods.
 */
export function Canopy({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          backgroundColor: color.brand[700],
          borderBottomLeftRadius: 28,
          borderBottomRightRadius: 28,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 20,
          zIndex: 2, // stays above the sheet that tucks under its rounded corners
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
