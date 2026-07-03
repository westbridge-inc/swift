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
import { FoodItemCard } from '../../../components/customer/FoodItemCard';
import { SwiftMark } from '../../../components/SwiftLogo';
import { vendorImage, categoryImage, DARK_BLURHASH } from '../../../lib/images';

// Swift is the *honest local marketplace* — no commission, no markup, no customer
// fees. Vendors & riders keep 100% and pay a flat weekly fee; customers pay the
// real price in cash. That truth is the spine of this screen, not a banner.

type Vertical = { key: string; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; route?: string };
const VERTICALS: Vertical[] = [
  { key: 'food', label: 'Food', icon: 'silverware-fork-knife', route: 'Search' },
  { key: 'grocery', label: 'Groceries', icon: 'basket-outline', route: 'Search' },
  { key: 'taxi', label: 'Taxi', icon: 'car', route: 'Taxi' },
  { key: 'courier', label: 'Send', icon: 'package-variant', route: 'Courier' },
  { key: 'shops', label: 'Shops', icon: 'shopping-outline', route: 'Search' },
  { key: 'services', label: 'Services', icon: 'tools', route: 'Services' },
];
// Photo-led tiles: the six doors of the app, each on real imagery (richer >
// cleaner). Hero pair = the daily drivers; the rest run compact underneath.
const TILE_SUB: Record<string, string> = {
  food: 'Hot & local',
  grocery: 'Market fresh',
  taxi: 'Rides',
  courier: 'Send it',
  shops: 'Retail',
  services: 'Pros',
};

const ratingOf = (v: any) => Number(v.averageRating ?? v.rating ?? 0);
const ratingLabel = (v: any) => (ratingOf(v) > 0 ? ratingOf(v).toFixed(1) : 'New');
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

// ── Star pill ────────────────────────────────────────────────────────────────
function StarPill({ value }: { value: string }) {
  return (
    <View className="flex-row items-center rounded-full bg-surface-base px-2.5 py-1" style={elevation.card}>
      <MaterialCommunityIcons name="star" size={12} color={color.brand[500]} />
      <Text className="ml-1 text-xs font-bold text-text-primary">{value}</Text>
    </View>
  );
}

// ── Photo category tiles ─────────────────────────────────────────────────────
function PhotoTile({ v, hero, onPress }: { v: Vertical; hero?: boolean; onPress?: () => void }) {
  const height = hero ? 116 : 86;
  return (
    <PressableScale strong onPress={onPress}>
      <View className="overflow-hidden rounded-3xl" style={elevation.raised}>
        <Image
          source={{ uri: categoryImage(v.key) }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          style={{ width: '100%', height }}
          contentFit="cover"
          transition={200}
        />
        <Scrim height={hero ? 76 : 60} from="rgba(10,11,15,0)" to="rgba(10,11,15,0.82)" />
        <View className="absolute inset-x-0 bottom-0 px-2.5 pb-2.5">
          <Text className={hero ? 'font-display text-lg font-extrabold text-white' : 'font-display text-[12px] font-bold text-white'} style={hero ? undefined : { letterSpacing: -0.3 }} numberOfLines={1}>
            {v.label}
          </Text>
          {hero ? (
            <Text className="text-xs font-semibold text-white" style={{ opacity: 0.85 }} numberOfLines={1}>
              {TILE_SUB[v.key]}
            </Text>
          ) : null}
        </View>
      </View>
    </PressableScale>
  );
}

// ── Vendor cards — clean WHITE photo cards (reference look) ───────────────────
const VendorPhotoCard = memo(function VendorPhotoCard({ vendor, onPress }: { vendor: any; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: 250, marginRight: 14 }}>
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

const VendorRow = memo(function VendorRow({ vendor, onPress }: { vendor: any; onPress?: () => void }) {
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
            className={active ? 'mr-sm rounded-full bg-brand-500 px-md py-sm' : 'mr-sm rounded-full bg-surface-base px-md py-sm'}
            style={active ? undefined : elevation.card}
          >
            <Text className={active ? 'text-sm font-bold text-white' : 'text-sm font-semibold text-text-secondary'}>{c}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ActiveOrderBanner({ order, onPress }: { order: any; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} className="mx-lg mb-sm flex-row items-center rounded-3xl px-lg py-md" style={[{ backgroundColor: color.brand[500] }, elevation.floating]}>
      <MaterialCommunityIcons name="bike-fast" size={24} color="#fff" />
      <View className="ml-sm flex-1">
        <Text className="text-sm font-bold text-white">Order on the way</Text>
        <Text className="text-xs text-white" style={{ opacity: 0.9 }} numberOfLines={1}>{order.orderNumber} · tap to track</Text>
      </View>
      <Feather name="chevron-right" size={20} color="#fff" />
    </Pressable>
  );
}

function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View className="mb-sm mt-lg flex-row items-end justify-between px-lg">
      <Heading size="lg">{title}</Heading>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}><Text className="text-sm font-bold text-brand-600">{action}</Text></Pressable>
      ) : null}
    </View>
  );
}

function HomeHeader({ navigation, address, activeOrder, popularItems, topRated, cuisines, selectedCuisine, onSelectCuisine }: any) {
  const heroes = VERTICALS.slice(0, 2);
  const rest = VERTICALS.slice(2);
  return (
    <View>
      {/* ── The Red Canopy — Swift's one sanctioned brand flood. The market-
           stall awning over the white sheet: identity, greeting and the
           no-fees promise live up here; everything below stays disciplined. */}
      <View className="px-lg pt-md" style={[{ backgroundColor: color.brand[700], paddingBottom: 40, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 }, elevation.raised]}>
        <View className="flex-row items-center">
          <SwiftMark size={26} tint="#FFFFFF" accent="#FFFFFF" />
          <Pressable className="ml-sm flex-1 flex-row items-center" onPress={() => navigation?.navigate?.('LocationPicker')}>
            <MaterialCommunityIcons name="map-marker" size={15} color="#fff" />
            <Text className="ml-0.5 text-sm font-bold text-white" numberOfLines={1}>{address || 'Set location'}</Text>
            <Feather name="chevron-down" size={15} color="rgba(255,255,255,0.8)" />
          </Pressable>
          <Pressable
            onPress={() => navigation?.navigate?.('Notifications')}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(255,255,255,0.14)' }}
          >
            <Feather name="bell" size={18} color="#fff" />
          </Pressable>
        </View>

        <Text className="font-display font-extrabold text-white" style={{ marginTop: 12, fontSize: 26, lineHeight: 32 }}>{greeting()}</Text>
        <Text className="text-white" style={{ marginTop: 4, fontSize: 14, lineHeight: 20, opacity: 0.85 }}>
          Order anything in town — real prices, zero fees.
        </Text>
      </View>

      {/* Search — a white pill breaking the canopy edge */}
      <Pressable
        onPress={() => navigation?.navigate?.('Search')}
        className="mx-lg flex-row items-center rounded-2xl bg-surface-base px-lg py-md"
        style={[elevation.floating, { marginTop: -26 }]}
      >
        <Feather name="search" size={18} color={color.brand[500]} />
        <Text className="ml-sm text-text-muted">Search food, shops, services…</Text>
      </Pressable>

      {activeOrder ? (
        <View className="mt-sm">
          <ActiveOrderBanner order={activeOrder} onPress={() => navigation?.navigate?.('OrderTracking', { id: activeOrder.id })} />
        </View>
      ) : null}

      {/* Six doors — real imagery, hero pair first */}
      <View className="flex-row px-lg pt-md" style={{ gap: 12 }}>
        {heroes.map((v, i) => (
          <Animated.View key={v.key} entering={enter.fadeUp.delay(staggerDelay(i))} style={{ flex: 1 }}>
            <PhotoTile v={v} hero onPress={() => v.route && navigation?.navigate?.(v.route)} />
          </Animated.View>
        ))}
      </View>
      <View className="flex-row px-lg pt-3" style={{ gap: 10 }}>
        {rest.map((v, i) => (
          <Animated.View key={v.key} entering={enter.fadeUp.delay(staggerDelay(i + 2))} style={{ flex: 1 }}>
            <PhotoTile v={v} onPress={() => v.route && navigation?.navigate?.(v.route)} />
          </Animated.View>
        ))}
      </View>

      {/* Open near you — clean white photo cards */}
      {topRated.length > 0 ? (
        <View>
          <SectionHeader title="Open near you" action="See all" onAction={() => navigation?.navigate?.('Search')} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
            {topRated.map((v: any) => (
              <VendorPhotoCard key={v.id} vendor={v} onPress={() => navigation?.navigate?.('VendorDetail', { id: v.id })} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Popular dishes — honest accent prices */}
      {popularItems?.length ? (
        <View>
          <SectionHeader title="Popular in town" action="See all" onAction={() => navigation?.navigate?.('Search')} />
          <View className="px-lg">
            {popularItems.slice(0, 5).map((it: any) => (
              <FoodItemCard key={it.id} item={it} onPress={() => navigation?.navigate?.('VendorDetail', { id: it.vendorId })} />
            ))}
          </View>
        </View>
      ) : null}

      {/* Trust — local + safe */}
      <View className="mx-lg mt-lg flex-row items-center rounded-2xl bg-surface-base px-lg py-md" style={elevation.card}>
        <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
        <Text className="ml-sm flex-1 text-[13px] font-medium text-text-secondary">
          Every Swift driver & rider is ID-verified and police-cleared.
        </Text>
      </View>

      <SectionHeader title="More places" />
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
  // First non-empty list — `??` won't fall through an empty `nearby: []`.
  const allVendors: any[] = useMemo(() => {
    const lists: any[][] = [home.nearby, home.openVendors, home.featured].filter(Array.isArray);
    return lists.find((a) => a.length) ?? [];
  }, [home.nearby, home.openVendors, home.featured]);

  const cuisines = useMemo(() => {
    const set = new Set<string>();
    for (const v of allVendors) for (const c of v.cuisineTypes ?? []) set.add(c);
    return Array.from(set).slice(0, 12);
  }, [allVendors]);

  const topRated = useMemo(() => [...allVendors].sort((a, b) => ratingOf(b) - ratingOf(a)).slice(0, 8), [allVendors]);
  const vendors = useMemo(
    () => (selectedCuisine ? allVendors.filter((v) => (v.cuisineTypes ?? []).includes(selectedCuisine)) : allVendors),
    [allVendors, selectedCuisine],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.brand[700] }} edges={['top']}>
      <View style={{ flex: 1 }} className="bg-surface-subtle">
        {/* only visible through top overscroll: the opaque content container
            covers it at rest, the gray wrapper covers the bottom */}
        <View pointerEvents="none" className="absolute left-0 right-0 top-0 h-60" style={{ backgroundColor: color.brand[700] }} />
        <List
          data={vendors}
          keyExtractor={(v: any) => String(v.id)}
          renderItem={({ item }: { item: any }) => (
            <View className="px-lg">
              <VendorRow vendor={item} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
          ListHeaderComponent={
            <HomeHeader
              navigation={navigation}
              address={address}
              activeOrder={home.activeOrder}
              popularItems={home.popularItems ?? []}
              topRated={topRated}
              cuisines={cuisines}
              selectedCuisine={selectedCuisine}
              onSelectCuisine={setSelectedCuisine}
            />
          }
          ListEmptyComponent={
            isLoading ? (
              <View className="px-lg">
                <Skeleton className="mb-md h-28 w-full rounded-3xl" />
                <Skeleton className="mb-md h-28 w-full rounded-3xl" />
                <Skeleton className="mb-md h-28 w-full rounded-3xl" />
              </View>
            ) : (
              <EmptyState icon="storefront-outline" title="Nothing nearby yet" body="We’re adding vendors in your area — check back soon." />
            )
          }
          contentContainerStyle={{ paddingBottom: 32, backgroundColor: color.surface.subtle }}
        />
      </View>
    </SafeAreaView>
  );
}
