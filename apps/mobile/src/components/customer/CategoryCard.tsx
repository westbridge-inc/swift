import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, PressableScale, elevation } from '../ui';

/**
 * Kit "Category Card" (square icon + label) — Swift's six doors on the Home
 * canopy sheet. Icon sits in a brand-tint circle on a white card.
 */
export function CategoryCard({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <PressableScale onPress={onPress} style={{ flex: 1 }}>
      <View
        className="items-center border border-border-subtle bg-surface-base py-md"
        style={[elevation.card, { borderRadius: 12 }]}
      >
        <View
          className="items-center justify-center"
          style={{ width: 44, height: 44, borderRadius: 100, backgroundColor: color.brand[50] }}
        >
          <MaterialCommunityIcons name={icon} size={24} color={color.brand[500]} />
        </View>
        <Text className="mt-sm font-medium text-text-primary" style={{ fontSize: 12 }}>{label}</Text>
      </View>
    </PressableScale>
  );
}
