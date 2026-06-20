import { memo } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Badge, Skeleton, Button, List, Image, PressableScale, EmptyState } from '../../components/ui';
import { useVendor, useCart, useAddToCart } from '../../hooks';
import { money } from '../../lib/money';
import { fallbackImage, kindForVendor, vendorImage, type ImageKind } from '../../lib/images';

type Row = { type: 'header'; key: string; name: string } | { type: 'item'; key: string; item: any };

const SHADOW = { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 } as const;

function BackButton({ onPress }: { onPress?: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      hitSlop={10}
      style={[{ position: 'absolute', top: 12, left: 16, zIndex: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
    >
      <Feather name="chevron-left" size={24} color={color.text.primary} />
    </PressableScale>
  );
}

const MenuItemRow = memo(function MenuItemRow({ item, onAdd, adding, kind }: { item: any; onAdd: () => void; adding: boolean; kind?: ImageKind }) {
  const unavailable = item.isAvailable === false;
  return (
    <View className="mx-lg flex-row items-start border-b border-border-subtle py-md">
      <View className="flex-1 pr-md">
        <Text className="text-base font-semibold text-text-primary">{item.name}</Text>
        {item.description ? (
          <Text className="mt-xs text-sm text-text-secondary" numberOfLines={2}>{item.description}</Text>
        ) : null}
        <Text className="mt-sm text-sm font-bold text-text-primary">{money(item.customerPrice ?? item.basePrice)}</Text>
      </View>
      <View style={{ width: 96, height: 96 }}>
        <Image source={{ uri: item.imageUrl || fallbackImage(item.id, kind) }} style={{ width: 96, height: 96, borderRadius: 14 }} />
        <PressableScale
          onPress={onAdd}
          disabled={unavailable || adding}
          hitSlop={8}
          style={[{ position: 'absolute', bottom: -10, right: -6, width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
        >
          <Feather name={unavailable ? 'slash' : 'plus'} size={18} color={unavailable ? color.text.muted : color.brand[500]} />
        </PressableScale>
      </View>
    </View>
  );
});

function VendorHeader({ vendor }: { vendor: any }) {
  const rating = vendor.averageRating && vendor.averageRating > 0 ? Number(vendor.averageRating).toFixed(1) : 'New';
  return (
    <View className="mb-sm">
      <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 210 }} />
      <View className="px-lg pt-md">
        <View className="flex-row items-start justify-between">
          <Heading size="2xl" className="flex-1 pr-md">{vendor.name}</Heading>
          {vendor.isCurrentlyOpen === false ? <Badge label="Closed" tone="brand" /> : <Badge label="Open" tone="success" />}
        </View>
        <View className="mt-sm flex-row items-center">
          <MaterialCommunityIcons name="star" size={15} color={color.brand[500]} />
          <Text className="ml-1 text-sm font-semibold text-text-primary">{rating}</Text>
          {vendor.totalRatings ? <Text className="ml-1 text-sm text-text-muted">({vendor.totalRatings})</Text> : null}
          <Text className="mx-2 text-text-muted">·</Text>
          <Feather name="clock" size={14} color={color.text.muted} />
          <Text className="ml-1 text-sm text-text-secondary">{vendor.estimatedPrepTime ?? 25} min</Text>
          {vendor.distanceKm != null ? (
            <>
              <Text className="mx-2 text-text-muted">·</Text>
              <Text className="text-sm text-text-secondary">{vendor.distanceKm} km</Text>
            </>
          ) : null}
        </View>
        {vendor.description ? <Text className="mt-sm text-sm text-text-secondary">{vendor.description}</Text> : null}
        {vendor.minOrderAmount ? (
          <Text className="mt-xs text-xs text-text-muted">Minimum order {money(vendor.minOrderAmount)}</Text>
        ) : null}
      </View>
    </View>
  );
}

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
          <Skeleton className="mb-md h-52 w-full rounded-2xl" />
          <Skeleton className="mb-sm h-6 w-2/3" />
          <Skeleton className="mb-lg h-4 w-1/2" />
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-md h-20 w-full rounded-xl" />)}
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !vendor) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <BackButton onPress={() => navigation?.goBack?.()} />
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="alert-circle-outline"
            title="Couldn’t load this place"
            body="Something went wrong on our end."
            actionLabel="Retry"
            onAction={() => refetch()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const categories: any[] = vendor.categories ?? [];
  const rows: Row[] = [];
  for (const cat of categories) {
    rows.push({ type: 'header', key: `h_${cat.id}`, name: cat.name });
    for (const it of cat.items ?? []) rows.push({ type: 'item', key: String(it.id), item: it });
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <BackButton onPress={() => navigation?.goBack?.()} />
      <View style={{ flex: 1 }}>
      <List
        data={rows}
        keyExtractor={(r: Row) => r.key}
        getItemType={(r: Row) => r.type}
        ListHeaderComponent={<VendorHeader vendor={vendor} />}
        renderItem={({ item: row }: { item: Row }) =>
          row.type === 'header' ? (
            <Heading size="lg" className="px-lg pb-sm pt-lg">{row.name}</Heading>
          ) : (
            <MenuItemRow
              item={row.item}
              kind={kindForVendor(vendor)}
              adding={addToCart.isPending}
              onAdd={() => addToCart.mutate({ vendorId: id, itemId: row.item.id, quantity: 1 })}
            />
          )
        }
        ListEmptyComponent={<EmptyState icon="silverware-fork-knife" title="No items yet" body="This place hasn’t added its menu — check back soon." />}
        contentContainerStyle={{ paddingBottom: 120 }}
      />
      </View>

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
