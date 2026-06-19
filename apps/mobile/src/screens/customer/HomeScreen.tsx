import { memo } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../../services/api';
import { useLocationStore } from '../../stores/locationStore';
import { color } from '@swift/ui';
import { Text, Heading, Skeleton, List, Image } from '../../components/ui';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Vertical = { key: string; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; route?: string };
const VERTICALS: Vertical[] = [
  { key: 'food', label: 'Food', icon: 'silverware-fork-knife', route: 'Search' },
  { key: 'grocery', label: 'Groceries', icon: 'cart-outline', route: 'Search' },
  { key: 'taxi', label: 'Taxi', icon: 'car', route: 'Taxi' },
  { key: 'courier', label: 'Courier', icon: 'package-variant', route: 'Courier' },
  { key: 'shops', label: 'Shops', icon: 'shopping-outline', route: 'Search' },
  { key: 'services', label: 'Services', icon: 'tools', route: 'Services' },
];

const FOOD_IMAGES = [
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=80',
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&q=80',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&q=80',
  'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&q=80',
  'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&q=80',
  'https://images.unsplash.com/photo-1432139555190-58524dae6a55?w=600&q=80',
];
const imageFor = (v: any, i: number) => v.coverImageUrl || v.logoUrl || FOOD_IMAGES[i % FOOD_IMAGES.length];
const ratingOf = (v: any) => Number(v.averageRating ?? v.rating ?? 4.7);
const etaOf = (v: any) => v.estimatedPrepTime ?? v.eta ?? '20–30';
const cuisineOf = (v: any) => (v.cuisineTypes && v.cuisineTypes[0]) || v.vendorType || 'Restaurant';

function VerticalTile({ v, onPress }: { v: Vertical; onPress?: () => void }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPressIn={() => { scale.value = withTiming(0.94, { duration: 80 }); }}
      onPressOut={() => { scale.value = withTiming(1, { duration: 120 }); }}
      onPress={onPress}
      style={[{ width: '31%', marginBottom: 16 }, animStyle]}
    >
      <View className="items-center">
        <View className="mb-xs h-16 w-16 items-center justify-center rounded-2xl bg-brand-50">
          <MaterialCommunityIcons name={v.icon} size={28} color={color.brand[500]} />
        </View>
        <Text className="text-sm font-semibold text-text-primary">{v.label}</Text>
      </View>
    </AnimatedPressable>
  );
}

function RatingPill({ value }: { value: number }) {
  return (
    <View className="flex-row items-center rounded-full bg-surface-subtle px-2 py-1">
      <MaterialCommunityIcons name="star" size={13} color={color.brand[500]} />
      <Text className="ml-1 text-xs font-semibold text-text-primary">{value.toFixed(1)}</Text>
    </View>
  );
}

const VendorCard = memo(function VendorCard({ vendor, index, onPress }: { vendor: any; index: number; onPress?: () => void }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPressIn={() => { scale.value = withTiming(0.98, { duration: 80 }); }}
      onPressOut={() => { scale.value = withTiming(1, { duration: 120 }); }}
      onPress={onPress}
      style={[{ marginBottom: 18 }, animStyle]}
    >
      <View
        className="overflow-hidden rounded-2xl bg-surface-base"
        style={{ shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 }}
      >
        <Image source={{ uri: imageFor(vendor, index) }} style={{ width: '100%', height: 150 }} />
        <View className="p-md">
          <View className="flex-row items-center justify-between">
            <Text className="flex-1 pr-sm text-base font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
            <RatingPill value={ratingOf(vendor)} />
          </View>
          <Text className="mt-1 text-sm text-text-secondary" numberOfLines={1}>{cuisineOf(vendor)}</Text>
          <View className="mt-xs flex-row items-center">
            <Feather name="clock" size={13} color={color.text.muted} />
            <Text className="ml-1 text-xs text-text-muted">{etaOf(vendor)} min</Text>
            <Text className="mx-2 text-xs text-text-muted">·</Text>
            <MaterialCommunityIcons name="shield-check" size={13} color={color.success} />
            <Text className="ml-1 text-xs text-text-muted">ID-verified</Text>
          </View>
        </View>
      </View>
    </AnimatedPressable>
  );
});

const FeaturedCard = memo(function FeaturedCard({ vendor, index, onPress }: { vendor: any; index: number; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: 248, marginRight: 14 }}>
      <View className="overflow-hidden rounded-2xl bg-surface-base" style={{ shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 3 }}>
        <Image source={{ uri: imageFor(vendor, index) }} style={{ width: '100%', height: 130 }} />
        <View className="p-sm">
          <View className="flex-row items-center justify-between">
            <Text className="flex-1 pr-sm text-sm font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
            <RatingPill value={ratingOf(vendor)} />
          </View>
          <Text className="mt-1 text-xs text-text-muted" numberOfLines={1}>{cuisineOf(vendor)} · {etaOf(vendor)} min</Text>
        </View>
      </View>
    </Pressable>
  );
});

function HomeHeader({ navigation, address, featured }: { navigation: any; address: string | null; featured: any[] }) {
  return (
    <View>
      {/* Location + notifications */}
      <View className="flex-row items-center justify-between px-lg pt-md pb-sm">
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

      {/* Search */}
      <Pressable
        onPress={() => navigation?.navigate?.('Search')}
        className="mx-lg mb-md flex-row items-center rounded-2xl bg-surface-subtle px-lg py-md"
      >
        <Feather name="search" size={18} color={color.text.muted} />
        <Text className="ml-sm text-text-muted">Search food, shops, services…</Text>
      </Pressable>

      {/* Trust strip */}
      <View className="mx-lg mb-lg flex-row items-center rounded-2xl bg-brand-50 px-lg py-md">
        <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
        <Text className="ml-sm flex-1 text-sm font-medium text-brand-700">
          Every Swift driver & rider is ID-verified and police-cleared.
        </Text>
      </View>

      {/* Verticals */}
      <View className="mb-sm px-lg"><Heading size="lg">What do you need?</Heading></View>
      <View className="flex-row flex-wrap justify-between px-lg">
        {VERTICALS.map((v) => (
          <VerticalTile key={v.key} v={v} onPress={() => v.route && navigation?.navigate?.(v.route)} />
        ))}
      </View>

      {/* Featured carousel */}
      {featured.length > 0 ? (
        <View className="mb-md">
          <View className="mb-sm px-lg"><Heading size="lg">Featured</Heading></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
            {featured.map((v, i) => (
              <FeaturedCard key={v.id} vendor={v} index={i} onPress={() => navigation?.navigate?.('VendorDetail', { id: v.id })} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Promo */}
      <View className="mx-lg my-md overflow-hidden rounded-2xl" style={{ backgroundColor: color.brand[500] }}>
        <View className="flex-row items-center p-lg">
          <View className="flex-1 pr-md">
            <Text className="text-lg font-bold text-white">Send a parcel across town</Text>
            <Text className="mt-1 text-sm text-white" style={{ opacity: 0.92 }}>Cash on delivery. No platform fees, ever.</Text>
          </View>
          <MaterialCommunityIcons name="moped" size={44} color="#fff" style={{ opacity: 0.9 }} />
        </View>
      </View>

      <View className="mb-sm mt-md px-lg"><Heading size="lg">Popular near you</Heading></View>
    </View>
  );
}

export function HomeScreen({ navigation }: any) {
  const { latitude, longitude, address } = useLocationStore();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['home', latitude, longitude],
    queryFn: async () => (await customerApi.getHome(latitude ?? undefined, longitude ?? undefined)).data,
  });
  const home = data?.data ?? {};
  const popular: any[] = home.vendors ?? home.popular ?? home.featured ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <List
        data={popular}
        keyExtractor={(v: any) => String(v.id)}
        renderItem={({ item, index }: { item: any; index: number }) => (
          <View className="px-lg">
            <VendorCard vendor={item} index={index} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
          </View>
        )}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
        ListHeaderComponent={<HomeHeader navigation={navigation} address={address} featured={popular.slice(0, 6)} />}
        ListEmptyComponent={
          isLoading ? (
            <View className="px-lg">
              <Skeleton className="mb-md h-48 w-full rounded-2xl" />
              <Skeleton className="mb-md h-48 w-full rounded-2xl" />
            </View>
          ) : (
            <Text className="px-lg text-text-secondary">Nothing nearby yet — check back soon.</Text>
          )
        }
        contentContainerStyle={{ paddingBottom: 32 }}
      />
    </SafeAreaView>
  );
}
