import { memo, useMemo, useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated from 'react-native-reanimated';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../../../services/api';
import { useLocationStore } from '../../../stores/locationStore';
import { color } from '@swift/ui';
import { Text, Heading, Skeleton, List, Image, PressableScale, EmptyState, enter, staggerDelay, elevation } from '../../../components/ui';
import { FoodItemCard } from '../../../components/customer/FoodItemCard';
import { SwiftMark } from '../../../components/SwiftLogo';
import { vendorImage } from '../../../lib/images';

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
const VERTICAL_TINT: Record<string, { bg: string; fg: string }> = {
  food: { bg: '#FFE9EB', fg: '#E8192C' },
  grocery: { bg: '#E7F7EE', fg: '#12A150' },
  taxi: { bg: '#FFF3DC', fg: '#E8842B' },
  courier: { bg: '#E7EEFF', fg: '#3B66E0' },
  shops: { bg: '#F1EAFE', fg: '#7C3AED' },
  services: { bg: '#E1F5F4', fg: '#0D9488' },
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

// ── Vertical launcher tile ───────────────────────────────────────────────────
function VerticalTile({ v, onPress }: { v: Vertical; onPress?: () => void }) {
  const tint = VERTICAL_TINT[v.key] ?? { bg: '#F2F2F4', fg: color.brand[500] };
  return (
    <PressableScale strong onPress={onPress}>
      <View className="items-center rounded-3xl bg-surface-base py-4" style={elevation.card}>
        <View className="mb-2 h-[52px] w-[52px] items-center justify-center rounded-2xl" style={{ backgroundColor: tint.bg }}>
          <MaterialCommunityIcons name={v.icon} size={26} color={tint.fg} />
        </View>
        <Text className="text-[13px] font-bold text-text-primary" numberOfLines={1}>{v.label}</Text>
      </View>
    </PressableScale>
  );
}

// ── The Swift promise — the business model AS the signature, not a discount ───
function PromisePill({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View className="flex-row items-center rounded-full bg-brand-50 px-3 py-1.5">
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <Text className="ml-1.5 text-xs font-bold text-brand-700">{label}</Text>
    </View>
  );
}
function PromiseBlock() {
  return (
    <View className="mx-lg mt-md overflow-hidden rounded-3xl bg-surface-base" style={elevation.card}>
      {/* a faint swift in flight behind the promise */}
      <View pointerEvents="none" style={{ position: 'absolute', right: -18, top: -14, opacity: 0.05, transform: [{ rotate: '-8deg' }] }}>
        <SwiftMark size={132} tint={color.text.primary} accent={color.text.primary} />
      </View>
      <View className="flex-row items-center px-lg pt-lg">
        <SwiftMark size={18} />
        <Text className="ml-2 text-[11px] font-bold uppercase tracking-[2px] text-brand-600">Why Swift</Text>
      </View>
      <Text className="px-lg pt-sm font-display text-[22px] font-extrabold leading-7 text-text-primary">
        You pay the vendor’s price.{'\n'}Nothing added — ever.
      </Text>
      <View className="flex-row flex-wrap px-lg pb-lg pt-md" style={{ gap: 8 }}>
        <PromisePill icon="cash-remove" label="$0 platform fees" />
        <PromisePill icon="hand-heart-outline" label="100% to the vendor" />
        <PromisePill icon="cash" label="Cash on delivery" />
      </View>
    </View>
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
  return (
    <View>
      {/* Brand header */}
      <View className="flex-row items-center px-lg pt-md">
        <SwiftMark size={26} />
        <Pressable className="ml-sm flex-1 flex-row items-center" onPress={() => navigation?.navigate?.('LocationPicker')}>
          <MaterialCommunityIcons name="map-marker" size={16} color={color.brand[500]} />
          <Text className="ml-0.5 text-sm font-bold text-text-primary" numberOfLines={1}>{address || 'Set location'}</Text>
          <Feather name="chevron-down" size={15} color={color.text.secondary} />
        </Pressable>
        <Pressable onPress={() => navigation?.navigate?.('Notifications')} className="h-10 w-10 items-center justify-center rounded-full bg-surface-base" style={elevation.card}>
          <Feather name="bell" size={18} color={color.text.primary} />
        </Pressable>
      </View>

      {/* Greeting + brand voice — the model, up front */}
      <View className="px-lg pt-md">
        <Heading size="2xl">{greeting()}</Heading>
        <Text className="mt-1 text-[15px] leading-5 text-text-secondary">
          Order anything in town. You pay the real price — <Text className="font-bold text-brand-600">never a fee</Text>.
        </Text>
      </View>

      {/* Search */}
      <Pressable
        onPress={() => navigation?.navigate?.('Search')}
        className="mx-lg mb-xs mt-md flex-row items-center rounded-2xl bg-surface-base px-lg py-md"
        style={elevation.card}
      >
        <Feather name="search" size={18} color={color.brand[500]} />
        <Text className="ml-sm text-text-muted">Search food, shops, services…</Text>
      </Pressable>

      {activeOrder ? (
        <View className="mt-sm">
          <ActiveOrderBanner order={activeOrder} onPress={() => navigation?.navigate?.('OrderTracking', { id: activeOrder.id })} />
        </View>
      ) : null}

      {/* Verticals */}
      <View className="flex-row flex-wrap justify-between px-lg pt-md">
        {VERTICALS.map((v, i) => (
          <Animated.View key={v.key} entering={enter.fadeUp.delay(staggerDelay(i))} style={{ width: '31%', marginBottom: 12 }}>
            <VerticalTile v={v} onPress={() => v.route && navigation?.navigate?.(v.route)} />
          </Animated.View>
        ))}
      </View>

      {/* The promise — business model as signature */}
      <PromiseBlock />

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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View style={{ flex: 1 }}>
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
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      </View>
    </SafeAreaView>
  );
}
