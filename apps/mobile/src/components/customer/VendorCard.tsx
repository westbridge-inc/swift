import { memo, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Image, Scrim, elevation, PressableScale } from '../ui';
import { vendorImage } from '../../lib/images';
import { useToggleFavorite } from '../../hooks';
import { useAuthStore } from '../../stores/authStore';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type Vendor = {
  id: string;
  name: string;
  vendorType?: string;
  averageRating?: number | null;
  rating?: number | null;
  totalRatings?: number | null;
  estimatedPrepTime?: number | null;
  etaMin?: number | null;
  cuisineTypes?: string[];
  isCurrentlyOpen?: boolean;
  distanceKm?: number | null;
  deliveryFee?: number | string | null;
  coverImageUrl?: string | null;
  logoUrl?: string | null;
  isFavorite?: boolean;
};

/** Heart toggle over the photo — optimistic, syncs via the favorites endpoint. */
function FavoriteHeart({ vendorId, initial }: { vendorId: string; initial?: boolean }) {
  const [fav, setFav] = useState(!!initial);
  const toggle = useToggleFavorite();
  return (
    <PressableScale
      onPress={() => {
        if (!useAuthStore.getState().isAuthenticated) { useAuthStore.getState().promptLogin(); return; }
        setFav((f) => !f);
        toggle.mutate({ vendorId, isFavorite: fav });
      }}
      hitSlop={8}
      className="h-9 w-9 items-center justify-center rounded-full bg-surface-base"
      style={elevation.card}
    >
      <MaterialCommunityIcons name={fav ? 'heart' : 'heart-outline'} size={18} color={fav ? color.brand[500] : color.text.secondary} />
    </PressableScale>
  );
}

/** A white pill that sits over photography — for ratings / ETA badges. */
function OverlayPill({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row items-center rounded-full bg-surface-base px-2.5 py-1" style={elevation.card}>
      {children}
    </View>
  );
}

/** Image-led vendor card (Home / Explore / favourites) — expo-image, memoized. */
export const VendorCard = memo(function VendorCard({ vendor, onPress }: { vendor: Vendor; onPress?: () => void }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const ratingValue = Number(vendor.averageRating ?? vendor.rating ?? 0);
  const rating = ratingValue > 0 ? ratingValue.toFixed(1) : 'New';
  const eta = vendor.estimatedPrepTime ?? vendor.etaMin ?? 25;
  const cuisine = vendor.cuisineTypes?.[0] ?? prettyType(vendor.vendorType);

  const fee = vendor.deliveryFee;
  const secondary =
    fee != null
      ? Number(fee) > 0
        ? `$${Number(fee)} delivery`
        : 'Free delivery'
      : vendor.distanceKm != null
        ? `${vendor.distanceKm} km away`
        : null;
  const closed = vendor.isCurrentlyOpen === false;

  return (
    <AnimatedPressable
      onPressIn={() => { scale.value = withTiming(0.98, { duration: 80 }); }}
      onPressOut={() => { scale.value = withTiming(1, { duration: 120 }); }}
      onPress={onPress}
      style={[{ marginBottom: 18 }, animStyle]}
    >
      <View className="overflow-hidden rounded-2xl bg-surface-base" style={elevation.floating}>
        <View>
          <Image
            source={{ uri: vendorImage(vendor) }}
            style={{ width: '100%', height: 172, opacity: closed ? 0.6 : 1 }}
          />
          <Scrim height={84} />
          <View className="absolute left-3 top-3">
            <FavoriteHeart vendorId={vendor.id} initial={vendor.isFavorite} />
          </View>
          <View className="absolute right-3 top-3">
            <OverlayPill>
              <MaterialCommunityIcons name="star" size={13} color={color.brand[500]} />
              <Text className="ml-1 text-xs font-bold text-text-primary">{rating}</Text>
            </OverlayPill>
          </View>
          <View className="absolute bottom-3 left-3 flex-row items-center rounded-full px-2.5 py-1" style={{ backgroundColor: 'rgba(0,0,0,0.42)' }}>
            <Feather name="clock" size={12} color="#fff" />
            <Text className="ml-1 text-xs font-semibold text-white">{eta} min</Text>
          </View>
          {closed ? (
            <View className="absolute inset-0 items-center justify-center">
              <View className="rounded-full px-4 py-1.5" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
                <Text className="text-sm font-bold text-white">Closed</Text>
              </View>
            </View>
          ) : null}
        </View>
        <View className="px-md py-md">
          <Text className="font-display text-[17px] font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
          <Text className="mt-0.5 text-sm text-text-secondary" numberOfLines={1}>
            {cuisine}{secondary ? `  ·  ${secondary}` : ''}
          </Text>
        </View>
      </View>
    </AnimatedPressable>
  );
});

function prettyType(t?: string): string {
  return t === 'SUPERMARKET' ? 'Groceries' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';
}
