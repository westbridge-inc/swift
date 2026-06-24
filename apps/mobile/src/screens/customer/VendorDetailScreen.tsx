import { memo, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Skeleton, Button, List, Image, PressableScale, EmptyState, Scrim } from '../../components/ui';
import { useVendor, useCart, useToggleFavorite } from '../../hooks';
import { useAuthStore } from '../../stores/authStore';
import { money } from '../../lib/money';
import { fallbackImage, kindForVendor, vendorImage, type ImageKind } from '../../lib/images';

type Row = { type: 'header'; key: string; name: string } | { type: 'item'; key: string; item: any };

const SHADOW = { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 } as const;

function BackButton({ onPress }: { onPress?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <PressableScale
      onPress={onPress}
      hitSlop={10}
      style={[{ position: 'absolute', top: insets.top + 8, left: 16, zIndex: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
    >
      <Feather name="chevron-left" size={24} color={color.text.primary} />
    </PressableScale>
  );
}

function FavoriteButton({ vendorId, initial }: { vendorId: string; initial?: boolean }) {
  const insets = useSafeAreaInsets();
  const [fav, setFav] = useState(!!initial);
  const toggle = useToggleFavorite();
  return (
    <PressableScale
      onPress={() => {
        if (!useAuthStore.getState().isAuthenticated) { useAuthStore.getState().promptLogin(); return; }
        setFav((f) => !f);
        toggle.mutate({ vendorId, isFavorite: fav });
      }}
      hitSlop={10}
      style={[{ position: 'absolute', top: insets.top + 8, right: 16, zIndex: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
    >
      <MaterialCommunityIcons name={fav ? 'heart' : 'heart-outline'} size={20} color={fav ? color.brand[500] : color.text.primary} />
    </PressableScale>
  );
}

const MenuItemRow = memo(function MenuItemRow({ item, onOpen, kind }: { item: any; onOpen: () => void; kind?: ImageKind }) {
  const unavailable = item.isAvailable === false;
  const customizable = (item.optionGroups?.length ?? 0) > 0;
  return (
    <PressableScale onPress={onOpen} disabled={unavailable}>
      <View className="mx-lg flex-row items-start border-b border-border-subtle py-md">
        <View className="flex-1 pr-md">
          <Text className="text-base font-semibold text-text-primary">{item.name}</Text>
          {item.description ? (
            <Text className="mt-xs text-sm text-text-secondary" numberOfLines={2}>{item.description}</Text>
          ) : null}
          <Text className="mt-sm text-sm font-bold text-text-primary">{money(item.customerPrice ?? item.basePrice)}</Text>
          {customizable && !unavailable ? (
            <Text className="mt-xs text-xs font-medium text-brand-600">Customizable</Text>
          ) : null}
        </View>
        <View style={{ width: 96, height: 96 }}>
          <Image source={{ uri: item.imageUrl || fallbackImage(item.id, kind) }} style={{ width: 96, height: 96, borderRadius: 14 }} />
          <View
            pointerEvents="none"
            style={[{ position: 'absolute', bottom: -10, right: -6, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: unavailable ? color.surface.base : color.brand[500] }, SHADOW]}
          >
            <Feather name={unavailable ? 'slash' : 'plus'} size={18} color={unavailable ? color.text.muted : '#fff'} />
          </View>
        </View>
      </View>
    </PressableScale>
  );
});

function StatusPill({ closed }: { closed: boolean }) {
  if (closed) {
    return (
      <View className="self-start rounded-full px-2.5 py-1" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
        <Text className="text-xs font-bold text-white">Closed</Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center self-start rounded-full bg-surface-base px-2.5 py-1">
      <View className="mr-1 h-2 w-2 rounded-full" style={{ backgroundColor: color.success }} />
      <Text className="text-xs font-bold text-text-primary">Open now</Text>
    </View>
  );
}

// Immersive hero — the vendor identity sits ON the photo over a gradient scrim
// (premium restaurant-detail treatment), with description/min-order below.
function VendorHeader({ vendor, onReviews }: { vendor: any; onReviews?: () => void }) {
  const rating = vendor.averageRating && vendor.averageRating > 0 ? Number(vendor.averageRating).toFixed(1) : 'New';
  const closed = vendor.isCurrentlyOpen === false;
  return (
    <View className="mb-sm">
      <View>
        <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 240 }} />
        <Scrim height={168} to="rgba(0,0,0,0.82)" />
        <View className="absolute inset-x-0 bottom-0 px-lg pb-lg">
          <StatusPill closed={closed} />
          <Heading size="3xl" className="mt-sm text-white">{vendor.name}</Heading>
          <View className="mt-xs flex-row items-center">
            <MaterialCommunityIcons name="star" size={15} color="#fff" />
            <Text className="ml-1 text-sm font-bold text-white">{rating}</Text>
            {vendor.totalRatings ? <Text className="ml-1 text-sm text-white" style={{ opacity: 0.8 }}>({vendor.totalRatings})</Text> : null}
            <Text className="mx-2 text-white" style={{ opacity: 0.6 }}>·</Text>
            <Feather name="clock" size={14} color="#fff" />
            <Text className="ml-1 text-sm text-white" style={{ opacity: 0.9 }}>{vendor.estimatedPrepTime ?? 25} min</Text>
            {vendor.distanceKm != null ? (
              <>
                <Text className="mx-2 text-white" style={{ opacity: 0.6 }}>·</Text>
                <Text className="text-sm text-white" style={{ opacity: 0.9 }}>{vendor.distanceKm} km</Text>
              </>
            ) : null}
          </View>
        </View>
      </View>
      {vendor.description || vendor.minOrderAmount ? (
        <View className="px-lg pt-md">
          {vendor.description ? <Text className="text-sm text-text-secondary">{vendor.description}</Text> : null}
          {vendor.minOrderAmount ? (
            <Text className="mt-xs text-xs text-text-muted">Minimum order {money(vendor.minOrderAmount)}</Text>
          ) : null}
        </View>
      ) : null}
      <PressableScale onPress={onReviews}>
        <View className="mt-sm flex-row items-center justify-between border-y border-border-subtle px-lg py-md">
          <View className="flex-row items-center">
            <MaterialCommunityIcons name="star" size={16} color={color.brand[500]} />
            <Text className="ml-1 text-sm font-bold text-text-primary">{rating}</Text>
            <Text className="ml-1 text-sm text-text-muted">· {vendor.totalRatings ? `${vendor.totalRatings} reviews` : 'No reviews yet'}</Text>
          </View>
          <View className="flex-row items-center">
            <Text className="text-sm font-semibold text-brand-600">See all</Text>
            <Feather name="chevron-right" size={16} color={color.brand[600]} />
          </View>
        </View>
      </PressableScale>
    </View>
  );
}

export function VendorDetailScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  const { data: vendor, isLoading, isError, refetch } = useVendor<any>(id);
  const { data: cart } = useCart<any>();

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
      <FavoriteButton vendorId={id} initial={vendor.isFavorite} />
      <View style={{ flex: 1 }}>
      <List
        data={rows}
        keyExtractor={(r: Row) => r.key}
        getItemType={(r: Row) => r.type}
        ListHeaderComponent={<VendorHeader vendor={vendor} onReviews={() => navigation?.navigate?.('VendorReviews', { id, vendorName: vendor.name, averageRating: vendor.averageRating })} />}
        renderItem={({ item: row }: { item: Row }) =>
          row.type === 'header' ? (
            <Heading size="lg" className="px-lg pb-sm pt-lg">{row.name}</Heading>
          ) : (
            <MenuItemRow
              item={row.item}
              kind={kindForVendor(vendor)}
              onOpen={() => navigation?.navigate?.('ItemDetail', { vendorId: id, item: row.item, vendorKind: kindForVendor(vendor) })}
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
