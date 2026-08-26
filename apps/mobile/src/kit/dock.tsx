import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { Eyebrow } from './labels';
import { T } from './text';

/**
 * Dock — the bottom action bar that anchors cart, checkout, and pay screens:
 * a hairline-topped surface with the fact on the left (eyebrow + the number)
 * and the one action on the right. The dock owns the home-indicator inset so
 * screens stop hand-rolling `paddingBottom: insets.bottom` under every CTA.
 *
 * The fact side is honest by construction: `label` is the eyebrow
 * ("TOTAL · CASH ON DELIVERY"), `value` is the figure — pass <Money> so it
 * rides tabular figures. Screens with no fact (a lone "Continue") pass an
 * `action` only and it stretches full-width.
 */
export function Dock({
  label,
  value,
  action,
  children,
  style,
}: {
  label?: string;
  value?: ReactNode;
  /** The primary CTA (usually a PillButton). */
  action?: ReactNode;
  /** Escape hatch for docks that are not fact-plus-action (e.g. two buttons). */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const hasFact = label != null || value != null;

  return (
    <View
      style={[
        {
          backgroundColor: color.surface.base,
          borderTopWidth: 1,
          borderTopColor: color.border.subtle,
          paddingHorizontal: space.lg,
          paddingTop: space.md,
          paddingBottom: Math.max(space.md, insets.bottom),
        },
        style,
      ]}
    >
      {children ?? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          {hasFact ? (
            <View style={{ flex: 1 }}>
              {label ? <Eyebrow numberOfLines={1}>{label}</Eyebrow> : null}
              {typeof value === 'string' || typeof value === 'number' ? (
                <T variant="numL">{value}</T>
              ) : (
                value ?? null
              )}
            </View>
          ) : null}
          <View style={hasFact ? undefined : { flex: 1 }}>{action}</View>
        </View>
      )}
    </View>
  );
}
