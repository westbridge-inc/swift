import { View, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, Heading, Badge, Skeleton, Button } from '../../components/ui';
import { useVendor, useCart, useAddToCart } from '../../hooks';
import { money } from '../../lib/money';

const COVER_EMOJI: Record<string, string> = {
  RESTAURANT: '🍽️',
  SUPERMARKET: '🛒',
  STORE: '🛍️',
  SERVICE: '🛠️',
};

export function VendorDetailScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  const { data: vendor, isLoading, isError, refetch } = useVendor<any>(id);
  const { data: cart } = useCart<any>();
  const addToCart = useAddToCart();

  const cartCount = cart?.itemCount ?? 0;
  const cartSubtotal = cart?.subtotalCustomer ?? 0;

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="p-lg">
          <Skeleton className="mb-md h-36 w-full" />
          <Skeleton className="mb-sm h-6 w-2/3" />
          <Skeleton className="mb-lg h-4 w-1/2" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="mb-md h-16 w-full" />
          ))}
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !vendor) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center px-2xl">
          <Text className="text-3xl">⚠️</Text>
          <Text className="mt-sm text-center text-text-secondary">Couldn&apos;t load this place.</Text>
          <Button label="Retry" className="mt-md" onPress={() => refetch()} />
        </View>
      </SafeAreaView>
    );
  }

  const categories: any[] = vendor.categories ?? [];
  const rating = vendor.averageRating && vendor.averageRating > 0 ? vendor.averageRating.toFixed(1) : 'New';

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      {/* Back */}
      <View className="flex-row items-center px-lg py-sm">
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Text className="text-2xl">‹ Back</Text>
        </Pressable>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Cover */}
        <View className="mx-lg mb-md h-36 items-center justify-center rounded-xl bg-brand-50">
          <Text className="text-5xl">{COVER_EMOJI[vendor.vendorType] ?? '🏬'}</Text>
        </View>

        {/* Header */}
        <View className="px-lg">
          <View className="flex-row items-start justify-between">
            <Heading size="2xl" className="flex-1 pr-md">
              {vendor.name}
            </Heading>
            {vendor.isCurrentlyOpen === false ? (
              <Badge label="Closed" tone="brand" />
            ) : (
              <Badge label="Open" tone="success" />
            )}
          </View>
          <Text className="mt-xs text-sm text-text-secondary">
            {rating} ★{vendor.totalRatings ? ` (${vendor.totalRatings})` : ''} · {vendor.estimatedPrepTime ?? 25} min
            {vendor.distanceKm != null ? ` · ${vendor.distanceKm} km` : ''}
          </Text>
          {vendor.description ? (
            <Text className="mt-sm text-sm text-text-secondary">{vendor.description}</Text>
          ) : null}
          {vendor.minOrderAmount ? (
            <Text className="mt-xs text-xs text-text-muted">Minimum order {money(vendor.minOrderAmount)}</Text>
          ) : null}
        </View>

        {/* Menu */}
        {categories.length === 0 ? (
          <Text className="px-lg pt-xl text-text-secondary">No items listed yet.</Text>
        ) : (
          categories.map((cat) => (
            <View key={cat.id} className="mt-lg">
              <Heading size="lg" className="px-lg pb-sm">
                {cat.name}
              </Heading>
              {(cat.items ?? []).map((item: any) => {
                const unavailable = item.isAvailable === false;
                return (
                  <View
                    key={item.id}
                    className="mx-lg mb-sm flex-row items-start justify-between border-b border-border-subtle pb-sm"
                  >
                    <View className="flex-1 pr-md">
                      <Text className="text-base font-semibold">{item.name}</Text>
                      {item.description ? (
                        <Text className="mt-xs text-sm text-text-secondary" numberOfLines={2}>
                          {item.description}
                        </Text>
                      ) : null}
                      <Text className="mt-xs text-sm font-semibold text-text-primary">
                        {money(item.customerPrice ?? item.basePrice)}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => addToCart.mutate({ vendorId: id, itemId: item.id, quantity: 1 })}
                      disabled={unavailable || addToCart.isPending}
                      className={
                        unavailable
                          ? 'rounded-full border border-border-subtle px-lg py-sm'
                          : 'rounded-full border border-brand-500 px-lg py-sm active:bg-brand-50'
                      }
                    >
                      <Text
                        className={unavailable ? 'text-sm font-semibold text-text-muted' : 'text-sm font-semibold text-brand-500'}
                      >
                        {unavailable ? 'Sold out' : 'Add'}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>

      {/* Live cart bar */}
      {cartCount > 0 ? (
        <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
          <Button onPress={() => navigation?.navigate?.('Cart')}>
            <View className="w-full flex-row items-center justify-between">
              <Text className="font-body font-semibold text-white">
                View cart · {cartCount} {cartCount === 1 ? 'item' : 'items'}
              </Text>
              <Text className="font-body font-semibold text-white">{money(cartSubtotal)}</Text>
            </View>
          </Button>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
