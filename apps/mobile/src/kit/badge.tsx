import { View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space, withAlpha } from '@swift/ui';
import { T } from './text';

type Tone = 'brand' | 'success' | 'error' | 'neutral';

const SURFACE: Record<Tone, { bg: string; fg: string }> = {
  brand: { bg: color.brand[50], fg: color.brand[600] },
  success: { bg: withAlpha(color.success, 0.1), fg: color.success },
  error: { bg: withAlpha(color.error, 0.1), fg: color.error },
  neutral: { bg: color.surface.subtle, fg: color.text.secondary },
};

/**
 * Small pill — trust/verified signals and order-status chips. Static and
 * label-bearing: never colour alone (the tone tints, the WORD tells).
 *
 * [DRIFT-09] Kit port of components/ui/badge. Same visual contract; the
 * className prop is gone (kit styles through tokens + `style`). DRIFT-10:
 * Badge, TonePill and Chip are three ROLES (static pill · static status
 * label · 48pt touch target) — never merge them.
 */
export function Badge({ label, tone = 'brand', style }: { label: string; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  const s = SURFACE[tone];
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          borderRadius: radius.full,
          paddingHorizontal: space.sm,
          paddingVertical: space.xs,
          backgroundColor: s.bg,
        },
        style,
      ]}
    >
      <T variant="micro" weight="semibold" style={{ color: s.fg }}>
        {label}
      </T>
    </View>
  );
}
