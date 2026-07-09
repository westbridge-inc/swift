import React from 'react';
import { Dimensions, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useHome, useToggleFavorite } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { useLocationStore } from '../../../stores/locationStore';
import { vendorImage, FOOD_IMAGES } from '../../../lib/images';
import {
  Card,
  Chip,
  CircleChip,
  ErrorState,
  FoodCard,
  GradientMasthead,
  LoadingBlock,
  PillButton,
  PromoBanner,
  RatingMeta,
  SectionHeader,
  T,
  VendorRow,
} from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const CARD_W = (SCREEN_W - GUTTER * 2 - space.lg) / 2;

// Category chip emoji — presentation-only mapping over real category names.
function categoryEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('burger')) return '🍔';
  if (n.includes('pizza')) return '🍕';
  if (n.includes('chicken')) return '🍗';
  if (n.includes('drink') || n.includes('juice') || n.includes('bever')) return '🥤';
  if (n.includes('dessert') || n.includes('cake') || n.includes('sweet')) return '🍰';
  if (n.includes('seafood') || n.includes('fish') || n.includes('shrimp')) return '🦐';
  if (n.includes('roti') || n.includes('curry') || n.includes('indian')) return '🫓';
  if (n.includes('chinese') || n.includes('noodle') || n.includes('chow')) return '🍜';
  if (n.includes('creole') || n.includes('rice')) return '🍛';
  if (n.includes('breakfast') || n.includes('egg')) return '🍳';
  if (n.includes('salad') || n.includes('health') || n.includes('veg')) return '🥗';
  if (n.includes('coffee') || n.includes('cafe')) return '☕';
  if (n.includes('grocer') || n.includes('market')) return '🛒';
  return '🍽️';
}

// Swift is a super-app: every vertical is one tap from Home (kit tile language).
const VERTICALS: { key: string; emoji: string; label: string; nav: (n: any) => void }[] = [
  { key: 'food', emoji: '🍔', label: 'Food', nav: (n) => n.navigate('Search', { type: 'RESTAURANT' }) },
  { key: 'grocery', emoji: '🛒', label: 'Groceries', nav: (n) => n.navigate('Search', { type: 'SUPERMARKET' }) },
  { key: 'taxi', emoji: '🚕', label: 'Taxi', nav: (n) => n.navigate('Taxi') },
  { key: 'courier', emoji: '📦', label: 'Send', nav: (n) => n.navigate('Courier') },
  { key: 'services', emoji: '🧰', label: 'Services', nav: (n) => n.navigate('Services') },
];

const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Waiting for the store',
  ACCEPTED: 'Order accepted',
  PREPARING: 'Being prepared',
  READY: 'Ready for pickup',
  RIDER_ASSIGNED: 'Rider on the way to store',
  PICKED_UP: 'On its way to you',
};

export function HomeScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, promptLogin } = useAuthStore();
  const { latitude, longitude } = useLocationStore();

  const home = useHome<any>(latitude ?? undefined, longitude ?? undefined);
  const toggleFav = useToggleFavorite();

  const onFavorite = (vendorId: string, isFavorite: boolean) => {
    if (!isAuthenticated) {
      promptLogin();
      return;
    }
    toggleFav.mutate({ vendorId, isFavorite });
  };

  const feed = home.data;
  const featured: any[] = feed?.featured ?? [];
  const nearby: any[] = feed?.nearby ?? [];
  const categories: { id: string; name: string }[] = feed?.categories ?? [];
  const activeOrder = feed?.activeOrder;

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space['3xl'] }}
        refreshControl={
          <RefreshControl refreshing={home.isRefetching} onRefresh={() => home.refetch()} tintColor={color.white} />
        }
      >
        {/* Kit Home V1 masthead: greeting · bell · avatar, display headline. */}
        <GradientMasthead style={{ paddingTop: insets.top + space.md, paddingBottom: 72 }}>
          <View style={{ paddingHorizontal: GUTTER }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <T variant="heading" tone="onBrand">
                  Hi{user?.firstName ? `! ${user.firstName}` : ' there!'}
                </T>
                <T variant="caption" style={{ color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
                  Welcome to Swift
                </T>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <CircleChip icon="bell" light onPress={() => navigation.navigate('Notifications')} />
                <Pressable onPress={() => navigation.navigate('Tabs', { screen: 'Profile' })}>
                  {user?.avatar ? (
                    <Image
                      source={{ uri: user.avatar }}
                      style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.brand[50] }}
                    />
                  ) : (
                    <View
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: color.surface.base,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <T variant="heading" tone="brand">
                        {(user?.firstName?.[0] ?? 'S').toUpperCase()}
                      </T>
                    </View>
                  )}
                </Pressable>
              </View>
            </View>

            <T variant="display" tone="onBrand" style={{ marginTop: space['2xl'], maxWidth: 320 }}>
              The best food in town, to your door! 🍔
            </T>
          </View>
        </GradientMasthead>

        {/* Overlapping card: live order when one exists, otherwise the promo. */}
        <View style={{ paddingHorizontal: GUTTER, marginTop: -56 }}>
          {activeOrder ? (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.success }} />
                  <T variant="body" weight="semibold">
                    {ORDER_STATUS_LABEL[activeOrder.status] ?? 'Order in progress'}
                  </T>
                </View>
                <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  {activeOrder.vendor?.name} · #{activeOrder.orderNumber}
                </T>
              </View>
              <PillButton
                label="Track"
                variant="dark"
                size="sm"
                onPress={() => navigation.navigate('Delivery', { orderId: activeOrder.id })}
              />
            </Card>
          ) : (
            <PromoBanner
              title="0% fees"
              sub="No markups — pay cash on delivery."
              cta="Order Now"
              image={FOOD_IMAGES[2]}
              onPress={() => navigation.navigate('Search')}
            />
          )}
        </View>

        {/* Vertical tiles — the super-app surface (food/grocery/taxi/courier/services) */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingHorizontal: GUTTER,
            marginTop: space.xl,
          }}
        >
          {VERTICALS.map((v) => (
            <Pressable key={v.key} onPress={() => v.nav(navigation)} style={{ alignItems: 'center', gap: 6 }}>
              {({ pressed }) => (
                <>
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: radius.md,
                      backgroundColor: pressed ? color.brand[100] : color.brand[50],
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <T style={{ fontSize: 26, lineHeight: 32 }}>{v.emoji}</T>
                  </View>
                  <T variant="caption" weight="medium" tone={pressed ? 'brand' : 'ink'}>
                    {v.label}
                  </T>
                </>
              )}
            </Pressable>
          ))}
        </View>

        {home.isLoading ? (
          <LoadingBlock style={{ paddingTop: 96 }} />
        ) : home.isError ? (
          <ErrorState onRetry={() => home.refetch()} style={{ paddingTop: 48 }} />
        ) : (
          <>
            {/* Find by Category */}
            {categories.length > 0 ? (
              <>
                <SectionHeader
                  title="Find by Category"
                  onSeeAll={() => navigation.navigate('Search')}
                  style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }}
                />
                <FlatList
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  data={categories}
                  keyExtractor={(c) => c.id}
                  contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.md, paddingTop: space.lg }}
                  renderItem={({ item }) => (
                    <Chip
                      label={item.name}
                      emoji={categoryEmoji(item.name)}
                      onPress={() => navigation.navigate('Search', { q: item.name })}
                    />
                  )}
                />
              </>
            ) : null}

            {/* Recommended for you — kit 2-col photo grid */}
            <SectionHeader
              title="Recommended for you"
              onSeeAll={() => navigation.navigate('Recommended')}
              style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }}
            />
            {featured.length === 0 ? (
              <T variant="label" tone="muted" style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
                No open restaurants right now — check back soon.
              </T>
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: space.lg,
                  paddingHorizontal: GUTTER,
                  paddingTop: space.lg,
                }}
              >
                {featured.slice(0, 6).map((v) => (
                  <FoodCard
                    key={v.id}
                    width={CARD_W}
                    image={vendorImage(v)}
                    name={v.name}
                    rating={Number(v.averageRating) || 0}
                    meta={v.etaMin ? `${v.etaMin} min` : undefined}
                    favorite={v.isFavorite}
                    onToggleFavorite={() => onFavorite(v.id, !!v.isFavorite)}
                    onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                  />
                ))}
              </View>
            )}

            {/* Nearby — only when location produced results (no fake proximity) */}
            {nearby.length > 0 ? (
              <>
                <SectionHeader
                  title="Nearby"
                  onSeeAll={() => navigation.navigate('Nearby')}
                  style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }}
                />
                <View style={{ paddingHorizontal: GUTTER, paddingTop: space.lg, gap: space.md }}>
                  {nearby.slice(0, 4).map((v) => (
                    <VendorRow
                      key={v.id}
                      image={vendorImage(v)}
                      name={v.name}
                      meta={
                        <RatingMeta
                          rating={Number(v.averageRating) || 0}
                          extra={v.distanceKm != null ? `${v.distanceKm} km` : undefined}
                        />
                      }
                      onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {/* Groceries & shops — the non-restaurant storefronts, same shop flow */}
            {(() => {
              const shops = (feed?.openVendors ?? []).filter(
                (v: any) => v.vendorType === 'SUPERMARKET' || v.vendorType === 'STORE',
              );
              if (shops.length === 0) return null;
              return (
                <>
                  <SectionHeader
                    title="Groceries & shops"
                    onSeeAll={() => navigation.navigate('Search', { type: 'SUPERMARKET' })}
                    style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }}
                  />
                  <FlatList
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    data={shops.slice(0, 8)}
                    keyExtractor={(v: any) => v.id}
                    contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                    renderItem={({ item: v }) => (
                      <FoodCard
                        width={CARD_W}
                        image={vendorImage(v)}
                        name={v.name}
                        rating={Number(v.averageRating) || 0}
                        meta={v.etaMin ? `${v.etaMin} min` : undefined}
                        favorite={v.isFavorite}
                        onToggleFavorite={() => onFavorite(v.id, !!v.isFavorite)}
                        onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                      />
                    )}
                  />
                </>
              );
            })()}
          </>
        )}
      </ScrollView>
    </View>
  );
}
