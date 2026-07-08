import { useMemo, useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useHome } from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { useAuthStore } from '../../../stores/authStore';
import { color } from '@swift/ui';
import { Text, Skeleton, List, EmptyState, Avatar, SectionHeader, BrandGradient, elevation } from '../../../components/ui';
import { FoodItemCard } from '../../../components/customer/FoodItemCard';
import { VendorPhotoCard, VendorCardGrid, ratingOf } from '../../../components/customer/VendorCards';
import { CategoryCard } from '../../../components/customer/CategoryCard';
import { mediaUrl } from '../../../lib/images';

// Swift is the *honest local marketplace* — no commission, no markup, no customer
// fees. Vendors & riders keep 100% and pay a flat weekly fee; customers pay the
// real price in cash. That truth is the spine of this screen, not a banner.
// Layout follows the Super Food kit (Home V1 canopy + V3 header anatomy).

type Vertical = { key: string; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; route?: string };
const VERTICALS: Vertical[] = [
  { key: 'food', label: 'Food', icon: 'silverware-fork-knife', route: 'Search' },
  { key: 'grocery', label: 'Groceries', icon: 'basket-outline', route: 'Search' },
  { key: 'taxi', label: 'Taxi', icon: 'car', route: 'Taxi' },
  { key: 'courier', label: 'Send', icon: 'package-variant', route: 'Courier' },
  { key: 'shops', label: 'Shops', icon: 'shopping-outline', route: 'Search' },
  { key: 'services', label: 'Services', icon: 'tools', route: 'Services' },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'good morning';
  if (h < 17) return 'good afternoon';
  return 'good evening';
}

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
            className={active ? 'mr-sm rounded-full px-lg py-sm' : 'mr-sm rounded-full bg-surface-base px-lg py-sm'}
            style={active ? { backgroundColor: color.brand[500] } : elevation.card}
          >
            <Text className={active ? 'font-semibold text-white' : 'font-medium text-text-secondary'} style={{ fontSize: 14 }}>{c}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ActiveOrderBanner({ order, onPress }: { order: any; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="mx-lg flex-row items-center px-lg py-md"
      style={[{ backgroundColor: color.brand[500], borderRadius: 12 }, elevation.floating]}
    >
      <MaterialCommunityIcons name="bike-fast" size={24} color="#fff" />
      <View className="ml-sm flex-1">
        <Text className="font-bold text-white" style={{ fontSize: 14 }}>Order on the way</Text>
        <Text className="text-white" style={{ fontSize: 12, opacity: 0.9 }} numberOfLines={1}>{order.orderNumber} · tap to track</Text>
      </View>
      <Feather name="chevron-right" size={20} color="#fff" />
    </Pressable>
  );
}

function HomeHeader({ navigation, address, user, activeOrder, popularItems, topRated, cuisines, selectedCuisine, onSelectCuisine }: any) {
  const firstName = user?.name?.trim()?.split(/\s+/)[0];
  return (
    <View>
      {/* ── The canopy — kit Home V1's brand masthead (warm gradient) with the
           V3 header row (avatar · location · bell), greeting and display line. */}
      <View
        className="px-lg pt-md"
        style={{
          backgroundColor: color.brand[600],
          paddingBottom: 46,
          borderBottomLeftRadius: 28,
          borderBottomRightRadius: 28,
          overflow: 'hidden',
        }}
      >
        <BrandGradient />
        <View className="flex-row items-center">
          <Pressable onPress={() => navigation?.navigate?.('Account')}>
            <Avatar name={user?.name} uri={mediaUrl(user?.avatar)} size={40} />
          </Pressable>
          <Pressable className="ml-md flex-1 flex-row items-center" onPress={() => navigation?.navigate?.('LocationPicker')}>
            <MaterialCommunityIcons name="map-marker" size={16} color="#fff" />
            <Text className="ml-1 font-semibold text-white" style={{ fontSize: 14 }} numberOfLines={1}>
              {address || 'Set location'}
            </Text>
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

        <Text className="mt-lg font-semibold text-white" style={{ fontSize: 20 }}>
          {firstName ? `Hi ${firstName}, ${greeting()}! 👋` : `Hi, ${greeting()}! 👋`}
        </Text>
        <Text className="mt-xs font-display font-extrabold text-white" style={{ fontSize: 32, lineHeight: 38 }}>
          Order anything in town
        </Text>
        <Text className="mt-xs text-white" style={{ fontSize: 14, opacity: 0.85 }}>
          Real prices · zero fees · pay cash
        </Text>
      </View>

      {/* Search — kit field breaking the canopy edge */}
      <Pressable
        onPress={() => navigation?.navigate?.('Search')}
        className="mx-lg flex-row items-center bg-surface-base px-lg"
        style={[elevation.floating, { marginTop: -26, height: 52, borderRadius: 12 }]}
      >
        <Feather name="search" size={18} color={color.brand[500]} />
        <Text className="ml-sm text-text-muted" style={{ fontSize: 14 }}>Search food, shops, services…</Text>
      </Pressable>

      {activeOrder ? (
        <View className="mt-md">
          <ActiveOrderBanner order={activeOrder} onPress={() => navigation?.navigate?.('OrderTracking', { id: activeOrder.id })} />
        </View>
      ) : null}

      {/* Six doors — kit category cards */}
      <View className="flex-row px-lg pt-lg" style={{ gap: 10 }}>
        {VERTICALS.slice(0, 3).map((v) => (
          <CategoryCard key={v.key} label={v.label} icon={v.icon} onPress={() => v.route && navigation?.navigate?.(v.route)} />
        ))}
      </View>
      <View className="flex-row px-lg pt-sm" style={{ gap: 10 }}>
        {VERTICALS.slice(3).map((v) => (
          <CategoryCard key={v.key} label={v.label} icon={v.icon} onPress={() => v.route && navigation?.navigate?.(v.route)} />
        ))}
      </View>

      {/* Recommended for you — kit portrait food cards */}
      {popularItems?.length ? (
        <View>
          <SectionHeader title="Recommended for you" action="See All" onAction={() => navigation?.navigate?.('Search')} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12, paddingBottom: 4 }}>
            {popularItems.slice(0, 8).map((it: any) => (
              <FoodItemCard key={it.id} item={it} onPress={() => navigation?.navigate?.('VendorDetail', { id: it.vendorId })} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Open near you — kit nearby restaurant cards */}
      {topRated.length > 0 ? (
        <View>
          <SectionHeader title="Open near you" action="See All" onAction={() => navigation?.navigate?.('Search')} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
            {topRated.map((v: any) => (
              <VendorPhotoCard key={v.id} vendor={v} onPress={() => navigation?.navigate?.('VendorDetail', { id: v.id })} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Trust — local + safe */}
      <View
        className="mx-lg mt-xl flex-row items-center bg-surface-base px-lg py-md"
        style={[elevation.card, { borderRadius: 12 }]}
      >
        <View className="items-center justify-center" style={{ width: 36, height: 36, borderRadius: 100, backgroundColor: color.brand[50] }}>
          <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[500]} />
        </View>
        <Text className="ml-md flex-1 font-medium text-text-secondary" style={{ fontSize: 13 }}>
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
  const user = useAuthStore((s) => s.user);
  const [selectedCuisine, setSelectedCuisine] = useState<string | undefined>(undefined);

  // Shared hook = shared key namespace: favorites/order mutations invalidate
  // ['customer','home'], so a locally-keyed query would never refresh.
  const { data, isLoading, isError, refetch, isRefetching } = useHome<any>(latitude ?? undefined, longitude ?? undefined);
  const home = data ?? {};
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
    <SafeAreaView style={{ flex: 1, backgroundColor: color.brand[600] }} edges={['top']}>
      <View style={{ flex: 1 }} className="bg-surface-subtle">
        {/* only visible through top overscroll: the opaque content container
            covers it at rest, the paper wrapper covers the bottom */}
        <View pointerEvents="none" className="absolute left-0 right-0 top-0 h-60" style={{ backgroundColor: color.brand[600] }} />
        <List
          data={vendors}
          numColumns={2}
          keyExtractor={(v: any) => String(v.id)}
          renderItem={({ item }: { item: any }) => (
            <View style={{ flex: 1, paddingHorizontal: 6, marginBottom: 12 }}>
              <VendorCardGrid vendor={item} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
          ListHeaderComponent={
            // Header is designed full-bleed (px-lg inside); cancel the list's
            // grid gutter so canopy and sections hit the true screen edges.
            <View style={{ marginHorizontal: -10 }}>
              <HomeHeader
                navigation={navigation}
                address={address}
                user={user}
                activeOrder={home.activeOrder}
                popularItems={home.popularItems ?? []}
                topRated={topRated}
                cuisines={cuisines}
                selectedCuisine={selectedCuisine}
                onSelectCuisine={setSelectedCuisine}
              />
            </View>
          }
          ListEmptyComponent={
            isLoading ? (
              <View className="px-sm">
                <Skeleton className="mb-md h-28 w-full" />
                <Skeleton className="mb-md h-28 w-full" />
                <Skeleton className="mb-md h-28 w-full" />
              </View>
            ) : isError ? (
              <EmptyState
                icon="wifi-off"
                title="Couldn’t load Home"
                body="Check your connection and try again."
                actionLabel="Retry"
                onAction={() => refetch()}
              />
            ) : (
              <EmptyState icon="storefront-outline" title="Nothing nearby yet" body="We’re adding vendors in your area — check back soon." />
            )
          }
          contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 10, backgroundColor: color.surface.subtle }}
        />
      </View>
    </SafeAreaView>
  );
}
