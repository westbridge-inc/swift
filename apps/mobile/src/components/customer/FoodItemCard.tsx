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
  averageRating?: number;
};

/**
 * Kit "Card Food – Portrait": white r12 card, padded photo (r8), name,
 * rating · vendor row, price in brand bold. Tapping anywhere opens the
 * vendor/item so modifiers & quantity are chosen there — never a blind add
 * that could mis-price a customisable item. Load-bearing type sizes are
 * inline (reused-card rule: arbitrary text-[N] utilities have burned us).
 */
export const FoodItemCard = memo(function FoodItemCard({
  item,
  onPress,
  width = 157,
}: {
  item: PopularItem;
  onPress?: () => void;
  width?: number;
}) {
  const rating = Number(item.averageRating ?? 0);
  return (
    <PressableScale onPress={onPress} style={{ width }}>
      <View className="border border-border-subtle bg-surface-base p-sm" style={[elevation.card, { borderRadius: 12 }]}>
        <View>
          <Image source={{ uri: itemImage(item) }} style={{ width: '100%', height: 118, borderRadius: 8 }} />
          <View
            className="items-center justify-center bg-white"
            style={[elevation.card, { position: 'absolute', bottom: 6, right: 6, width: 30, height: 30, borderRadius: 100 }]}
          >
            <MaterialCommunityIcons name="plus" size={16} color={color.text.primary} />
          </View>
        </View>
        <View className="pt-sm">
          <Text className="font-medium text-text-primary" style={{ fontSize: 16 }} numberOfLines={1}>
            {item.name}
          </Text>
          <View className="mt-xs flex-row items-center">
            {rating > 0 ? (
              <>
                <MaterialCommunityIcons name="star" size={14} color={color.warning} />
                <Text className="ml-0.5 mr-md font-medium text-text-primary" style={{ fontSize: 12 }}>{rating.toFixed(1)}</Text>
              </>
            ) : null}
            {item.vendorName ? (
              <Text className="flex-1 font-medium text-text-secondary" style={{ fontSize: 12 }} numberOfLines={1}>
                {item.vendorName}
              </Text>
            ) : null}
          </View>
          <Text className="mt-xs font-bold" style={{ fontSize: 16, color: color.brand[500] }}>{money(item.price)}</Text>
        </View>
      </View>
    </PressableScale>
  );
});
