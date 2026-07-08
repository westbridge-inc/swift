import { memo } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Image, PressableScale, elevation } from '../ui';
import { vendorImage } from '../../lib/images';

// Kit-anatomy vendor cards (Super Food "Card Restaurant" family) on Swift
// tokens, with the Swift model ("no fees · cash") woven in. Shared across
// Home, Search, Favorites and anywhere vendors are listed, so the whole app
// is one language. Load-bearing type sizes are inline (reused-card rule).

export const ratingOf = (v: any) => Number(v.averageRating ?? v.rating ?? 0);
export const ratingLabel = (v: any) => (ratingOf(v) > 0 ? ratingOf(v).toFixed(1) : 'New');
export const etaOf = (v: any) => v.etaMin ?? v.estimatedPrepTime ?? v.eta ?? '20–30';
export const prettyType = (t?: string) =>
  t === 'SUPERMARKET' ? 'Groceries' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';
export const cuisineOf = (v: any) => (v.cuisineTypes && v.cuisineTypes[0]) || prettyType(v.vendorType);

/** Kit rating badge — dark translucent pill over imagery (star + value). */
export function StarPill({ value }: { value: string }) {
  return (
    <View
      className="flex-row items-center px-sm py-0.5"
      style={{ backgroundColor: 'rgba(31,26,26,0.62)', borderRadius: 6 }}
    >
      <MaterialCommunityIcons name="star" size={12} color={color.warning} />
      <Text className="ml-1 font-medium text-white" style={{ fontSize: 12 }}>{value}</Text>
    </View>
  );
}

/** Kit "Card Restaurant – Nearby": rail card — photo with rating badge,
 *  name, cuisine, eta line. */
export const VendorPhotoCard = memo(function VendorPhotoCard({
  vendor,
  onPress,
  width = 168,
}: {
  vendor: any;
  onPress?: () => void;
  width?: number;
}) {
  return (
    <PressableScale onPress={onPress} style={{ width, marginRight: 12 }}>
      <View className="bg-surface-base" style={[elevation.card, { borderRadius: 12, padding: 10 }]}>
        <View>
          <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 104, borderRadius: 8 }} />
          <View style={{ position: 'absolute', top: 7, right: 7 }}>
            <StarPill value={ratingLabel(vendor)} />
          </View>
        </View>
        <View className="pt-sm">
          <Text className="font-medium text-text-primary" style={{ fontSize: 14 }} numberOfLines={1}>{vendor.name}</Text>
          <Text className="mt-0.5 text-text-secondary" style={{ fontSize: 12 }} numberOfLines={1}>{cuisineOf(vendor)}</Text>
          <View className="mt-sm flex-row items-center">
            <Feather name="clock" size={13} color={color.text.secondary} />
            <Text className="ml-1 text-text-secondary" style={{ fontSize: 12 }}>{etaOf(vendor)} min · no fees</Text>
          </View>
        </View>
      </View>
    </PressableScale>
  );
});

/** Kit "Card Restaurant": 2-up grid card for vendor list screens. */
export const VendorCardGrid = memo(function VendorCardGrid({
  vendor,
  onPress,
}: {
  vendor: any;
  onPress?: () => void;
}) {
  const closed = vendor.isCurrentlyOpen === false;
  return (
    <PressableScale onPress={onPress} style={{ flex: 1 }}>
      <View className="bg-surface-base" style={[elevation.card, { borderRadius: 12, padding: 10 }]}>
        <View>
          <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 104, borderRadius: 8 }} />
          <View style={{ position: 'absolute', top: 7, right: 7 }}>
            <StarPill value={ratingLabel(vendor)} />
          </View>
          {closed ? (
            <View
              className="items-center justify-center"
              style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(251,251,249,0.55)', borderRadius: 8 }}
            >
              <Text className="font-semibold text-text-primary" style={{ fontSize: 12 }}>Closed now</Text>
            </View>
          ) : null}
        </View>
        <View className="pt-sm">
          <Text className="font-medium text-text-primary" style={{ fontSize: 14 }} numberOfLines={1}>{vendor.name}</Text>
          <Text className="mt-0.5 text-text-secondary" style={{ fontSize: 12 }} numberOfLines={1}>{cuisineOf(vendor)}</Text>
          <View className="mt-sm flex-row items-center">
            <Feather name="clock" size={13} color={color.text.secondary} />
            <Text className="ml-1 flex-1 text-text-secondary" style={{ fontSize: 12 }} numberOfLines={1}>
              {etaOf(vendor)} min · {closed ? 'closed' : 'no fees'}
            </Text>
          </View>
        </View>
      </View>
    </PressableScale>
  );
});

/** Kit "Card Food – Landscape" anatomy as the full-width vendor list row. */
export const VendorRow = memo(function VendorRow({ vendor, onPress }: { vendor: any; onPress?: () => void }) {
  const closed = vendor.isCurrentlyOpen === false;
  return (
    <PressableScale onPress={onPress} className="mb-md">
      <View
        className="flex-row bg-surface-base"
        style={[elevation.card, { borderRadius: 12, padding: 12 }]}
      >
        <Image source={{ uri: vendorImage(vendor) }} style={{ width: 100, height: 100, borderRadius: 8 }} />
        <View className="ml-md flex-1">
          <Text className="font-medium text-text-primary" style={{ fontSize: 16 }} numberOfLines={1}>{vendor.name}</Text>
          <Text className="mt-0.5 text-text-secondary" style={{ fontSize: 12 }} numberOfLines={1}>{cuisineOf(vendor)}</Text>
          <View className="mt-xs flex-row items-center">
            <MaterialCommunityIcons name="star" size={14} color={color.warning} />
            <Text className="ml-0.5 font-medium text-text-primary" style={{ fontSize: 12 }}>{ratingLabel(vendor)}</Text>
            <Feather name="clock" size={13} color={color.text.secondary} style={{ marginLeft: 14 }} />
            <Text className="ml-1 text-text-secondary" style={{ fontSize: 12 }}>{etaOf(vendor)} min</Text>
          </View>
          <View className="mt-auto flex-row items-center pt-xs">
            {closed ? (
              <Text className="font-semibold text-text-muted" style={{ fontSize: 12 }}>Closed now</Text>
            ) : (
              <>
                <MaterialCommunityIcons name="cash" size={14} color={color.success} />
                <Text className="ml-1 font-medium text-text-secondary" style={{ fontSize: 12 }}>No fees · cash on delivery</Text>
              </>
            )}
          </View>
        </View>
      </View>
    </PressableScale>
  );
});
