import { memo, useMemo, useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated from 'react-native-reanimated';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../../../services/api';
import { useLocationStore } from '../../../stores/locationStore';
import { color } from '@swift/ui';
import { Text, Heading, Skeleton, List, Image, PressableScale, EmptyState, Scrim, enter, staggerDelay, elevation } from '../../../components/ui';
import { VendorCard } from '../../../components/customer/VendorCard';
import { categoryImage, vendorImage, DARK_BLURHASH } from '../../../lib/images';

type Vertical = { key: string; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; route?: string };
const VERTICALS: Vertical[] = [
  { key: 'food', label: 'Food', icon: 'silverware-fork-knife', route: 'Search' },
  { key: 'grocery', label: 'Groceries', icon: 'cart-outline', route: 'Search' },
  { key: 'taxi', label: 'Taxi', icon: 'car', route: 'Taxi' },
  { key: 'courier', label: 'Courier', icon: 'package-variant', route: 'Courier' },
  { key: 'shops', label: 'Shops', icon: 'shopping-outline', route: 'Search' },
  { key: 'services', label: 'Services', icon: 'tools', route: 'Services' },
];

const ratingOf = (v: any) => Number(v.averageRating ?? v.rating ?? 0);
const etaOf = (v: any) => v.etaMin ?? v.estimatedPrepTime ?? v.eta ?? '20–30';
const cuisineOf = (v: any) => (v.cuisineTypes && v.cuisineTypes[0]) || prettyType(v.vendorType);
const prettyType = (t?: string) =>
  t === 'SUPERMARKET' ? 'Groceries' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Photo-led category tile — real imagery + dark scrim + label, so the grid reads
// rich instead of flat-white. The glyph + label always render, so a slow photo
// (dark blurhash) still communicates the category.
function VerticalTile({ v, onPress }: { v: Vertical; onPress?: () => void }) {
  return (
    <PressableScale strong onPress={onPress}>
      <View className="h-[92px] overflow-hidden rounded-2xl bg-surface-subtle" style={elevation.card}>
        <Image
          source={{ uri: categoryImage(v.key) }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          style={{ width: '100%', height: '100%' }}
        />
        <Scrim cover from="rgba(0,0,0,0.10)" to="rgba(0,0,0,0.62)" />
        <View className="absolute left-2.5 top-2.5">
          <MaterialCommunityIcons name={v.icon} size={18} color="#fff" />
        </View>
        <Text className="absolute bottom-2.5 left-2.5 right-2 text-[13px] font-bold text-white" numberOfLines={1}>
          {v.label}
        </Text>
      </View>
    </PressableScale>
  );
}

function RatingPill({ value, onDark }: { value: number; onDark?: boolean }) {
  const label = value > 0 ? value.toFixed(1) : 'New';
  return (
    <View className="flex-row items-center rounded-full bg-surface-base px-2.5 py-1" style={onDark ? elevation.card : undefined}>
      <MaterialCommunityIcons name="star" size={13} color={color.brand[500]} />
      <Text className="ml-1 text-xs font-bold text-text-primary">{label}</Text>
    </View>
  );
}

// Featured rail card — title sits ON the photo over a scrim (the premium
// "editorial" treatment), distinct from the list cards below.
const FeaturedCard = memo(function FeaturedCard({ vendor, onPress }: { vendor: any; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: 264, marginRight: 14 }}>
      <View className="overflow-hidden rounded-2xl bg-surface-base" style={elevation.floating}>
        <View>
          <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: 156 }} />
          <Scrim height={116} to="rgba(0,0,0,0.78)" />
          <View className="absolute right-3 top-3">
            <RatingPill value={ratingOf(vendor)} onDark />
          </View>
          <View className="absolute bottom-3 left-3 right-3">
            <Text className="font-display text-base font-bold text-white" numberOfLines={1}>{vendor.name}</Text>
            <Text className="mt-0.5 text-xs text-white" style={{ opacity: 0.9 }} numberOfLines={1}>{cuisineOf(vendor)} · {etaOf(vendor)} min</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
});

function CuisineChips({ cuisines, selected, onSelect }: { cuisines: string[]; selected?: string; onSelect: (c?: string) => void }) {
  const all = ['All', ...cuisines];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }} className="mb-sm">
      {all.map((c) => {
        const active = (c === 'All' && !selected) || c === selected;
        return (
          <Pressable
            key={c}
            onPress={() => onSelect(c === 'All' ? undefined : c)}
            className={active ? 'mr-sm rounded-full bg-brand-500 px-md py-sm' : 'mr-sm rounded-full bg-surface-subtle px-md py-sm'}
          >
            <Text className={active ? 'text-sm font-semibold text-white' : 'text-sm font-medium text-text-secondary'}>{c}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ActiveOrderBanner({ order, onPress }: { order: any; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} className="mx-lg mb-md flex-row items-center rounded-2xl px-lg py-md" style={[{ backgroundColor: color.brand[500] }, elevation.floating]}>
      <MaterialCommunityIcons name="bike-fast" size={24} color="#fff" />
      <View className="ml-sm flex-1">
        <Text className="text-sm font-bold text-white">Order in progress</Text>
        <Text className="text-xs text-white" style={{ opacity: 0.9 }} numberOfLines={1}>{order.orderNumber} · tap to track</Text>
      </View>
      <Feather name="chevron-right" size={20} color="#fff" />
    </Pressable>
  );
}

function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View className="mb-sm mt-md flex-row items-center justify-between px-lg">
      <Heading size="lg">{title}</Heading>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text className="text-sm font-semibold text-brand-600">{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function HomeHeader({ navigation, address, activeOrder, topRated, cuisines, selectedCuisine, onSelectCuisine }: any) {
  return (
    <View>
      <View className="flex-row items-center justify-between px-lg pt-md">
        <Pressable className="flex-1 flex-row items-center" onPress={() => navigation?.navigate?.('LocationPicker')}>
          <MaterialCommunityIcons name="map-marker" size={20} color={color.brand[500]} />
          <View className="ml-xs flex-1">
            <Text className="text-xs text-text-muted">Deliver to</Text>
            <View className="flex-row items-center">
              <Text className="text-base font-bold text-text-primary" numberOfLines={1}>{address || 'Set your location'}</Text>
              <Feather name="chevron-down" size={16} color={color.text.secondary} />
            </View>
          </View>
        </Pressable>
        <Pressable
          onPress={() => navigation?.navigate?.('Notifications')}
          className="h-10 w-10 items-center justify-center rounded-full bg-surface-subtle"
        >
          <Feather name="bell" size={18} color={color.text.primary} />
        </Pressable>
      </View>

      <View className="px-lg pt-md">
        <Heading size="3xl">{greeting()}</Heading>
        <Text className="mt-0.5 text-base text-text-secondary">What can we get you today?</Text>
      </View>

      <Pressable
        onPress={() => navigation?.navigate?.('Search')}
        className="mx-lg mb-md mt-md flex-row items-center rounded-2xl border border-border-subtle bg-surface-base px-lg py-md"
        style={elevation.card}
      >
        <Feather name="search" size={18} color={color.brand[500]} />
        <Text className="ml-sm text-text-muted">Search food, shops, services…</Text>
      </Pressable>

      <View className="flex-row flex-wrap justify-between px-lg pt-xs">
        {VERTICALS.map((v, i) => (
          <Animated.View key={v.key} entering={enter.fadeUp.delay(staggerDelay(i))} style={{ width: '31%', marginBottom: 14 }}>
            <VerticalTile v={v} onPress={() => v.route && navigation?.navigate?.(v.route)} />
          </Animated.View>
        ))}
      </View>

      <View className="mx-lg mb-md flex-row items-center rounded-2xl bg-brand-50 px-lg py-md">
        <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
        <Text className="ml-sm flex-1 text-sm font-medium text-brand-700">
          Every Swift driver & rider is ID-verified and police-cleared.
        </Text>
      </View>

      {activeOrder ? (
        <ActiveOrderBanner order={activeOrder} onPress={() => navigation?.navigate?.('OrderTracking', { id: activeOrder.id })} />
      ) : null}

      {topRated.length > 0 ? (
        <View className="mb-sm">
          <SectionHeader title="Top rated near you" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
            {topRated.map((v: any) => (
              <FeaturedCard key={v.id} vendor={v} onPress={() => navigation?.navigate?.('VendorDetail', { id: v.id })} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      <Pressable
        onPress={() => navigation?.navigate?.('Courier')}
        className="mx-lg my-md overflow-hidden rounded-2xl"
        style={[{ backgroundColor: color.brand[500] }, elevation.floating]}
      >
        <View className="flex-row items-center p-lg">
          <View className="flex-1 pr-md">
            <Text className="text-lg font-bold text-white">Send a parcel across town</Text>
            <Text className="mt-1 text-sm text-white" style={{ opacity: 0.92 }}>Cash on delivery. No platform fees, ever.</Text>
          </View>
          <MaterialCommunityIcons name="moped" size={44} color="#fff" style={{ opacity: 0.95 }} />
        </View>
      </Pressable>

      <SectionHeader title="Near you" />
      <CuisineChips cuisines={cuisines} selected={selectedCuisine} onSelect={onSelectCuisine} />
    </View>
  );
}

export function HomeScreen({ navigation }: any) {
  const { latitude, longitude, address } = useLocationStore();
  const [selectedCuisine, setSelectedCuisine] = useState<string | undefined>(undefined);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['home', latitude, longitude],
    queryFn: async () => (await customerApi.getHome(latitude ?? undefined, longitude ?? undefined)).data,
  });
  const home = data?.data ?? {};
  const allVendors: any[] = useMemo(
    () => home.nearby ?? home.openVendors ?? home.featured ?? [],
    [home.nearby, home.openVendors, home.featured],
  );

  const cuisines = useMemo(() => {
    const set = new Set<string>();
    for (const v of allVendors) for (const c of v.cuisineTypes ?? []) set.add(c);
    return Array.from(set).slice(0, 12);
  }, [allVendors]);

  const topRated = useMemo(
    () => [...allVendors].filter((v) => ratingOf(v) > 0).sort((a, b) => ratingOf(b) - ratingOf(a)).slice(0, 6),
    [allVendors],
  );

  const vendors = useMemo(
    () => (selectedCuisine ? allVendors.filter((v) => (v.cuisineTypes ?? []).includes(selectedCuisine)) : allVendors),
    [allVendors, selectedCuisine],
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View style={{ flex: 1 }}>
        <List
          data={vendors}
          keyExtractor={(v: any) => String(v.id)}
          renderItem={({ item }: { item: any }) => (
            <View className="px-lg">
              <VendorCard vendor={item} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
          ListHeaderComponent={
            <HomeHeader
              navigation={navigation}
              address={address}
              activeOrder={home.activeOrder}
              topRated={topRated}
              cuisines={cuisines}
              selectedCuisine={selectedCuisine}
              onSelectCuisine={setSelectedCuisine}
            />
          }
          ListEmptyComponent={
            isLoading ? (
              <View className="px-lg">
                <Skeleton className="mb-md h-48 w-full rounded-2xl" />
                <Skeleton className="mb-md h-48 w-full rounded-2xl" />
              </View>
            ) : (
              <EmptyState
                icon="storefront-outline"
                title="Nothing nearby yet"
                body="We’re adding vendors in your area — check back soon."
              />
            )
          }
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      </View>
    </SafeAreaView>
  );
}
