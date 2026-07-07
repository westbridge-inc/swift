import { color } from '@swift/ui';
import { memo } from 'react';
import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Image, PressableScale, elevation } from '../ui';
import { itemImage } from '../../lib/images';
import { money } from '../../lib/money';

export type PopularItem = {
  id: string;
  name: string;
  imageUrl?: string | null;
  price: number;
  vendorId: string;
  vendorName?: string;
};

/**
 * Compact rail card for popular dishes — photo-led, price in the red accent,
 * white + chip on the photo (same add language as the vendor menu). Tapping
 * anywhere opens the vendor/item so modifiers & quantity are chosen there —
 * never a blind add that could mis-price a customisable item.
 * Load-bearing type sizes are inline (reused-card rule: arbitrary text-[N]
 * utilities have burned us in the Metro cache).
 */
export const FoodItemCard = memo(function FoodItemCard({
  item,
  onPress,
}: {
  item: PopularItem;
  onPress?: () => void;
}) {
  return (
    <PressableScale onPress={onPress} style={{ width: 148 }}>
      <View className="overflow-hidden rounded-2xl bg-surface-base" style={elevation.card}>
        <View>
          <Image source={{ uri: itemImage(item) }} style={{ width: '100%', height: 106 }} />
          {/* Inline position: fresh spacing utilities are Metro-cache-fragile
              and a mis-anchored + reads as broken. */}
          <View
            className="items-center justify-center rounded-full bg-white"
            style={[elevation.card, { position: 'absolute', bottom: 6, right: 6, width: 28, height: 28 }]}
          >
            <MaterialCommunityIcons name="plus" size={16} color={color.text.primary} />
          </View>
        </View>
        <View className="px-2.5 pb-2.5 pt-2">
          <Text className="font-extrabold" style={{ fontSize: 13, color: color.brand[600] }}>{money(item.price)}</Text>
          <Text className="mt-0.5 font-semibold text-text-primary" style={{ fontSize: 13 }} numberOfLines={1}>
            {item.name}
          </Text>
          {item.vendorName ? (
            <Text className="text-text-muted" style={{ fontSize: 11 }} numberOfLines={1}>
              {item.vendorName}
            </Text>
          ) : null}
        </View>
      </View>
    </PressableScale>
  );
});
