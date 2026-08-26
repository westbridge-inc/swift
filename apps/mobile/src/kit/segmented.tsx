import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { cardShadow } from './card';
import { haptic } from '../lib/haptics';
import { T } from './text';

/**
 * Segmented — the range/mode switch (7D · 30D · 90D, Delivery · Pickup): a
 * sunken track where the selected segment sits as a raised white chip. One
 * value is ALWAYS selected — a segmented control is a lens, not a filter; for
 * optional many-of chips use ChoiceChip instead.
 *
 * Selection is announced structurally (`accessibilityState.selected` + the
 * raised chip), never by colour alone.
 */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: ReadonlyArray<{ key: K; label: string }>;
  value: K;
  onChange: (key: K) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={[
        {
          flexDirection: 'row',
          backgroundColor: color.surface.sunken,
          borderRadius: radius.full,
          padding: 3,
          gap: 2,
        },
        style,
      ]}
    >
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <Pressable
            key={opt.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.label}
            onPress={() => {
              if (!selected) {
                haptic.select();
                onChange(opt.key);
              }
            }}
            style={[
              {
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.full,
                paddingVertical: space.sm,
                paddingHorizontal: space.sm,
                minHeight: 32,
              },
              selected ? [{ backgroundColor: color.surface.base }, cardShadow] : null,
            ]}
          >
            <T
              variant="label"
              weight={selected ? 'semibold' : 'medium'}
              tone={selected ? 'ink' : 'muted'}
              numberOfLines={1}
            >
              {opt.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}
