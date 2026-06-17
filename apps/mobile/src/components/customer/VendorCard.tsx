import { Pressable, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Text, Card, Badge } from '../ui';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type Vendor = {
  id: string;
  name: string;
  vendorType?: string;
  averageRating?: number | null;
  totalRatings?: number | null;
  estimatedPrepTime?: number | null;
  cuisineTypes?: string[];
  isCurrentlyOpen?: boolean;
  distanceKm?: number | null;
};

/** Standard vendor row — reused across Explore, Home and favourites. */
export function VendorCard({ vendor, onPress }: { vendor: Vendor; onPress?: () => void }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const rating =
    vendor.averageRating != null && vendor.averageRating > 0 ? vendor.averageRating.toFixed(1) : 'New';
  const eta = vendor.estimatedPrepTime ?? 25;
  const meta = [
    vendor.cuisineTypes?.[0],
    vendor.distanceKm != null ? `${vendor.distanceKm} km` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withTiming(0.97, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withTiming(1, { duration: 120 });
      }}
      onPress={onPress}
      style={animStyle}
    >
      <Card className="mb-md flex-row items-start justify-between">
        <View className="flex-1 pr-md">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {vendor.name}
          </Text>
          <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
            {rating} ★ · {eta} min{meta ? ` · ${meta}` : ''}
          </Text>
        </View>
        {vendor.isCurrentlyOpen === false ? (
          <Badge label="Closed" tone="brand" />
        ) : (
          <Badge label="Open" tone="success" />
        )}
      </Card>
    </AnimatedPressable>
  );
}
