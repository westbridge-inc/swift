import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { cardShadow } from './card';

/**
 * MapPeek — the small framed map window on order/job detail screens: a fixed-
 * height rounded frame holding the live map, with an optional floating chip
 * (ETA, "En route") pinned to a corner and an optional tap-through to the
 * full-screen map. The frame owns clipping and the hairline so screens stop
 * re-inventing "map in a card" with ad-hoc overflow rules.
 *
 * The chip slot exists for SERVER facts only (ETA, driver state) — never
 * decorative copy. If there is nothing true to say, pass no chip.
 */
export function MapPeek({
  children,
  chip,
  chipPosition = 'bottomLeft',
  height = 200,
  onPress,
  accessibilityLabel,
  style,
}: {
  /** The map view itself (MapView, or an honest placeholder while loading). */
  children: ReactNode;
  chip?: ReactNode;
  chipPosition?: 'bottomLeft' | 'topRight';
  height?: number;
  /** Tap-through to the full map; omitting it renders a plain (non-button) frame. */
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const frame = (
    <View
      style={[
        {
          height,
          borderRadius: radius.xl,
          overflow: 'hidden',
          backgroundColor: color.surface.sunken,
          borderWidth: 1,
          borderColor: color.border.subtle,
        },
        !onPress ? style : null,
      ]}
    >
      {children}
      {chip ? (
        <View
          pointerEvents="box-none"
          style={[
            { position: 'absolute' },
            chipPosition === 'bottomLeft'
              ? { left: space.md, bottom: space.md }
              : { right: space.md, top: space.md },
          ]}
        >
          <View
            style={[
              {
                backgroundColor: color.surface.base,
                borderRadius: radius.full,
                paddingHorizontal: space.md,
                paddingVertical: space.xs,
              },
              cardShadow,
            ]}
          >
            {chip}
          </View>
        </View>
      ) : null}
    </View>
  );

  if (!onPress) return frame;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? 'Open full map'}
      style={style}
    >
      {frame}
    </Pressable>
  );
}
