import { memo } from 'react';
import { View, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Image, elevation } from '../ui';
import { vendorImage } from '../../lib/images';

// The fresh, reference-grade vendor cards — clean white surfaces, photo-forward,
// with the Swift model ("no fees · cash") woven in. Shared across Home, Search,
// Favorites and anywhere vendors are listed, so the whole app is one language.

export const ratingOf = (v: any) => Number(v.averageRating ?? v.rating ?? 0);
export const ratingLabel = (v: any) => (ratingOf(v) > 0 ? ratingOf(v).toFixed(1) : 'New');
export const etaOf = (v: any) => v.etaMin ?? v.estimatedPrepTime ?? v.eta ?? '20–30';
export const prettyType = (t?: string) =>
  t === 'SUPERMARKET' ? 'Groceries' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';
export const cuisineOf = (v: any) => (v.cuisineTypes && v.cuisineTypes[0]) || prettyType(v.vendorType);

export function StarPill({ value }: { value: string }) {
  return (
    <View className="flex-row items-center rounded-full bg-surface-base px-2.5 py-1" style={elevation.card}>
      <MaterialCommunityIcons name="star" size={12} color={color.brand[500]} />
      <Text className="ml-1 text-xs font-bold text-text-primary">{value}</Text>
    </View>
  );
}

/** Photo-led rail card — used in horizontal "near you" scrollers. */
export const VendorPhotoCard = memo(function VendorPhotoCard({
  vendor,
  onPress,
  width = 250,
}: {
  vendor: any;
  onPress?: () => void;
  width?: number;
}) {
  return (
    <Pressable onPress={onPress} style={{ width, marginRight: 14 }}>
      <View className="overflow-hidden rounded-3xl bg-surface-base" style={elevation.card}>
        <View>
          <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 132 }} />
          <View className="absolute left-3 top-3"><StarPill value={ratingLabel(vendor)} /></View>
        </View>
        <View className="px-4 py-3">
          <Text className="font-display text-base font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
          <Text className="mt-0.5 text-xs text-text-secondary" numberOfLines={1}>{cuisineOf(vendor)} · {etaOf(vendor)} min</Text>
          <View className="mt-2 flex-row items-center">
            <MaterialCommunityIcons name="cash" size={13} color={color.success} />
            <Text className="ml-1 text-xs font-semibold text-text-muted">Vendor’s price · no fees</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
});

/** Full-width list card — used in vertical vendor lists. */
export const VendorRow = memo(function VendorRow({ vendor, onPress }: { vendor: any; onPress?: () => void }) {
  const closed = vendor.isCurrentlyOpen === false;
  return (
    <Pressable onPress={onPress} className="mb-md">
      <View className="flex-row overflow-hidden rounded-3xl bg-surface-base" style={elevation.card}>
        <Image source={{ uri: vendorImage(vendor) }} style={{ width: 108, height: 108 }} />
        <View className="flex-1 px-md py-md">
          <View className="flex-row items-center">
            <Text className="flex-1 pr-sm font-display text-base font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
            <MaterialCommunityIcons name="star" size={13} color={color.brand[500]} />
            <Text className="ml-1 text-xs font-bold text-text-primary">{ratingLabel(vendor)}</Text>
          </View>
          <Text className="mt-0.5 text-sm text-text-secondary" numberOfLines={1}>{cuisineOf(vendor)} · {etaOf(vendor)} min</Text>
          <View className="mt-auto flex-row items-center pt-sm">
            {closed ? (
              <Text className="text-xs font-semibold text-text-muted">Closed now</Text>
            ) : (
              <>
                <MaterialCommunityIcons name="cash" size={13} color={color.success} />
                <Text className="ml-1 text-xs font-semibold text-text-muted">No fees · cash on delivery</Text>
              </>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
});
