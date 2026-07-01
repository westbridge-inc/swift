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
 * Horizontal dish card — photo + name + vendor + price + add. Tapping the card
 * (or the +) opens the item so modifiers/quantity are chosen there — the
 * bottom-sheet item-add pattern from the teardown, never a blind add that could
 * mis-price a customisable item.
 */
export const FoodItemCard = memo(function FoodItemCard({
  item,
  onPress,
}: {
  item: PopularItem;
  onPress?: () => void;
}) {
  return (
    <PressableScale onPress={onPress}>
      <View className="mb-md flex-row items-center rounded-2xl bg-surface-base p-2.5" style={elevation.card}>
        <Image source={{ uri: itemImage(item) }} style={{ width: 78, height: 78, borderRadius: 16 }} />
        <View className="ml-md flex-1">
          <Text className="text-[15px] font-bold text-text-primary" numberOfLines={1}>
            {item.name}
          </Text>
          {item.vendorName ? (
            <Text className="mt-0.5 text-xs text-text-muted" numberOfLines={1}>
              {item.vendorName}
            </Text>
          ) : null}
          <Text className="mt-1.5 text-[15px] font-extrabold text-brand-600">{money(item.price)}</Text>
        </View>
        <View className="h-9 w-9 items-center justify-center rounded-full bg-brand-500" style={elevation.card}>
          <MaterialCommunityIcons name="plus" size={20} color="#fff" />
        </View>
      </View>
    </PressableScale>
  );
});
