import { View, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../../services/api';
import { useLocationStore } from '../../stores/locationStore';
import { Text, Heading, Card, Badge, Skeleton } from '../../components/ui';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// The six verticals (spec §6.1) — Swift celebrates its breadth on the home hero.
const VERTICALS: Array<{ key: string; label: string; emoji: string; route?: string }> = [
  { key: 'food', label: 'Food', emoji: '🍛', route: 'Search' },
  { key: 'grocery', label: 'Groceries', emoji: '🛒', route: 'Search' },
  { key: 'taxi', label: 'Taxi', emoji: '🚖', route: 'Taxi' },
  { key: 'courier', label: 'Courier', emoji: '📦', route: 'Courier' },
  { key: 'shops', label: 'Shops', emoji: '🛍️', route: 'Search' },
  { key: 'services', label: 'Services', emoji: '🛠️', route: 'Services' },
];

function VerticalCard({ label, emoji, onPress }: { label: string; emoji: string; onPress?: () => void }) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPressIn={() => { scale.value = withTiming(0.96, { duration: 80 }); }}
      onPressOut={() => { scale.value = withTiming(1, { duration: 120 }); }}
      onPress={onPress}
      style={[{ width: '31%', marginBottom: 12 }, animStyle]}
    >
      <Card className="items-center py-lg">
        <Text className="text-3xl">{emoji}</Text>
        <Text className="mt-xs text-sm font-semibold">{label}</Text>
      </Card>
    </AnimatedPressable>
  );
}

export function HomeScreen({ navigation }: any) {
  const { latitude, longitude, address } = useLocationStore();

  const { data, isLoading } = useQuery({
    queryKey: ['home', latitude, longitude],
    queryFn: async () => (await customerApi.getHome(latitude ?? undefined, longitude ?? undefined)).data,
  });
  const home = data?.data ?? {};
  const popular: any[] = home.vendors ?? home.popular ?? home.featured ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <ScrollView className="flex-1 bg-surface-base" showsVerticalScrollIndicator={false}>
        {/* Header — greeting + location */}
        <View className="px-lg pt-md pb-sm">
          <Text className="text-sm text-text-secondary">Deliver to</Text>
          <Pressable className="flex-row items-center">
            <Text className="text-lg font-semibold" numberOfLines={1}>
              {address || 'Set your location'}
            </Text>
            <Text className="ml-xs text-brand-500">▾</Text>
          </Pressable>
        </View>

        {/* Search entry */}
        <Pressable
          onPress={() => navigation?.navigate?.('Search')}
          className="mx-lg mb-md flex-row items-center rounded-full border border-border-subtle bg-surface-subtle px-lg py-md"
        >
          <Text className="text-text-muted">🔍  Search food, shops, services…</Text>
        </Pressable>

        {/* Trust strip — the brand edge */}
        <View className="mx-lg mb-lg flex-row items-center rounded-lg bg-brand-50 px-lg py-md">
          <Text className="text-base">🛡️</Text>
          <Text className="ml-sm flex-1 text-sm text-brand-700">
            Every Swift driver & rider is ID-verified and police-cleared.
          </Text>
        </View>

        {/* Vertical switcher hero */}
        <View className="mb-sm px-lg">
          <Heading size="lg">What do you need?</Heading>
        </View>
        <View className="flex-row flex-wrap justify-between px-lg">
          {VERTICALS.map((v) => (
            <VerticalCard
              key={v.key}
              label={v.label}
              emoji={v.emoji}
              onPress={() => v.route && navigation?.navigate?.(v.route)}
            />
          ))}
        </View>

        {/* Promo banner — cash-only friendly, no fees */}
        <Card className="mx-lg my-md bg-brand-500">
          <Heading size="lg" className="text-white">Send a parcel across town</Heading>
          <Text className="mt-xs text-white">Cash on delivery. No platform fees, ever.</Text>
        </Card>

        {/* Popular near you */}
        <View className="mb-sm mt-md px-lg">
          <Heading size="lg">Popular near you</Heading>
        </View>
        <View className="px-lg pb-2xl">
          {isLoading ? (
            <>
              <Skeleton className="mb-md h-24 w-full" />
              <Skeleton className="mb-md h-24 w-full" />
            </>
          ) : popular.length === 0 ? (
            <Text className="text-text-secondary">Nothing nearby yet — check back soon.</Text>
          ) : (
            popular.slice(0, 8).map((v) => (
              <Pressable key={v.id} onPress={() => navigation?.navigate?.('VendorDetail', { id: v.id })}>
                <Card className="mb-md flex-row items-center justify-between">
                  <View className="flex-1 pr-md">
                    <Text className="text-base font-semibold" numberOfLines={1}>{v.name}</Text>
                    <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                      {(v.averageRating ?? v.rating ?? '—')} ★ · {v.estimatedPrepTime ?? v.eta ?? '20–30'} min
                    </Text>
                  </View>
                  {(v.isVerified ?? true) ? <Badge label="Verified" tone="success" /> : null}
                </Card>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
