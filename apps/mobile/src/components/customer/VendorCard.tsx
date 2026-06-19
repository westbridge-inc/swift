import { memo } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Image } from '../ui';
import { vendorImage } from '../../lib/images';

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
  coverImageUrl?: string | null;
  logoUrl?: string | null;
};

/** Image-led vendor card (Explore / Home / favourites) — expo-image, memoized. */
export const VendorCard = memo(function VendorCard({ vendor, onPress }: { vendor: Vendor; onPress?: () => void }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const rating =
    vendor.averageRating != null && vendor.averageRating > 0 ? Number(vendor.averageRating).toFixed(1) : 'New';
  const eta = vendor.estimatedPrepTime ?? 25;
  const meta = [
    vendor.cuisineTypes?.[0] ?? vendor.vendorType,
    vendor.distanceKm != null ? `${vendor.distanceKm} km` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const closed = vendor.isCurrentlyOpen === false;

  return (
    <AnimatedPressable
      onPressIn={() => { scale.value = withTiming(0.98, { duration: 80 }); }}
      onPressOut={() => { scale.value = withTiming(1, { duration: 120 }); }}
      onPress={onPress}
      style={[{ marginBottom: 18 }, animStyle]}
    >
      <View
        className="overflow-hidden rounded-2xl bg-surface-base"
        style={{ shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 }}
      >
        <View>
          <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 150 }} />
          {closed ? (
            <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}>
              <Text className="text-sm font-bold text-white">Closed</Text>
            </View>
          ) : null}
        </View>
        <View className="p-md">
          <View className="flex-row items-center justify-between">
            <Text className="flex-1 pr-sm text-base font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
            <View className="flex-row items-center rounded-full bg-surface-subtle px-2 py-1">
              <MaterialCommunityIcons name="star" size={13} color={color.brand[500]} />
              <Text className="ml-1 text-xs font-semibold text-text-primary">{rating}</Text>
            </View>
          </View>
          <View className="mt-xs flex-row items-center">
            <Feather name="clock" size={13} color={color.text.muted} />
            <Text className="ml-1 text-xs text-text-muted">{eta} min</Text>
            {meta ? (
              <>
                <Text className="mx-2 text-xs text-text-muted">·</Text>
                <Text className="flex-1 text-xs text-text-muted" numberOfLines={1}>{meta}</Text>
              </>
            ) : null}
          </View>
        </View>
      </View>
    </AnimatedPressable>
  );
});
