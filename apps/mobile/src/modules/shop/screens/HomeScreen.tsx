/** @jsxImportSource react */
import React from 'react';
import { Dimensions, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useHome, useToggleFavorite } from '../../../hooks/customer';
import { useAds } from '../../../hooks/ads';
import { AdHeroVideo, AdTopCard, AdBar } from '../../../components/ads';
import { useAuthStore } from '../../../stores/authStore';
import { useLocationStore } from '../../../stores/locationStore';
import { vendorImage, FOOD_IMAGES } from '../../../lib/images';
import {
  Card,
  Chip,
  ErrorState,
  FoodCard,
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
const RAIL_CARD_W = Math.round(SCREEN_W * 0.44);

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

// The super-app grid (Grab anatomy): every service one tap from the top of
// Home, drawn icons — never emoji. All destinations are REAL routes.
const SERVICES: {
  key: string;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  nav: (n: any) => void;
}[] = [
  { key: 'food', icon: 'silverware-fork-knife', label: 'Food', nav: (n) => n.navigate('Search', { type: 'RESTAURANT' }) },
  { key: 'grocery', icon: 'cart-outline', label: 'Groceries', nav: (n) => n.navigate('Search', { type: 'SUPERMARKET' }) },
  { key: 'shops', icon: 'storefront-outline', label: 'Shops', nav: (n) => n.navigate('Search', { type: 'STORE' }) },
  { key: 'taxi', icon: 'car', label: 'Taxi', nav: (n) => n.navigate('Taxi') },
  { key: 'courier', icon: 'cube-send', label: 'Send', nav: (n) => n.navigate('Courier') },
  { key: 'services', icon: 'hammer-wrench', label: 'Services', nav: (n) => n.navigate('Services') },
  { key: 'orders', icon: 'receipt', label: 'Orders', nav: (n) => n.navigate('Tabs', { screen: 'Activity' }) },
  { key: 'favorites', icon: 'heart-outline', label: 'Favourites', nav: (n) => n.navigate('Favorites') },
];

const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Waiting for the store',
  ACCEPTED: 'Order accepted',
  PREPARING: 'Being prepared',
  READY: 'Ready for pickup',
  RIDER_ASSIGNED: 'Rider on the way to store',
  PICKED_UP: 'On its way to you',
};

function kmLabel(km: unknown): string | undefined {
  const n = Number(km);
  if (!Number.isFinite(n)) return undefined;
  return n < 1 ? '<1 km' : `${n} km`;
}

function ServiceTile({ item, navigation }: { item: (typeof SERVICES)[number]; navigation: any }) {
  return (
    <Pressable onPress={() => item.nav(navigation)} style={{ width: '25%', alignItems: 'center', marginTop: space.lg }}>
      {({ pressed }) => (
        <>
          <View
            style={{
              width: 58,
              height: 58,
              borderRadius: radius.lg,
              backgroundColor: pressed ? color.brand[100] : color.brand[50],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MaterialCommunityIcons name={item.icon} size={26} color={color.brand[600]} />
          </View>
          <T variant="caption" weight="medium" tone={pressed ? 'brand' : 'ink'} style={{ marginTop: 6 }}>
            {item.label}
          </T>
        </>
      )}
    </Pressable>
  );
}

export function HomeScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, promptLogin } = useAuthStore();
  const { latitude, longitude, address } = useLocationStore();

  const home = useHome<any>(latitude ?? undefined, longitude ?? undefined);
  const toggleFav = useToggleFavorite();

  // Ads hydrate independently (§13.4): home content NEVER waits on this call,
  // and an ad-free answer collapses the slots so sections close up. Launch is
  // single-city → "*" everywhere (E11).
  const ads = useAds('*');
  const adSlots = ads.data?.data?.placements;
  const adTrackable = ads.data?.trackable ?? false;
  const heroAd = adSlots?.['home_hero_video']?.items[0];
  const topAd = adSlots?.['home_top_card']?.items[0];
  const barSlot = adSlots?.['home_ad_bar'];

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
  const orderAgain: any[] = feed?.orderAgain ?? [];
  const activeOrder = feed?.activeOrder;
  // Names repeat across stores ("Popular" everywhere) — one chip per name.
  const categories = React.useMemo(() => {
    const seen = new Set<string>();
    return ((feed?.categories ?? []) as { id: string; name: string }[]).filter((c) => {
      const k = c.name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [feed?.categories]);

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space['3xl'] }}
        refreshControl={
          <RefreshControl refreshing={home.isRefetching} onRefresh={() => home.refetch()} tintColor={color.white} />
        }
      >
        {/* Compact brand header: where + who, then search. No taglines — the
            services below ARE the message (Grab anatomy). */}
        <View style={{ backgroundColor: color.brand[500], paddingTop: insets.top + space.sm, paddingBottom: space.xl, paddingHorizontal: GUTTER }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable
              onPress={() => (isAuthenticated ? navigation.navigate('Addresses') : navigation.navigate('LocationPicker'))}
              style={{ flex: 1, paddingRight: space.md }}
            >
              <T variant="caption" weight="bold" style={{ color: 'rgba(255,255,255,0.72)', letterSpacing: 1 }}>
                DELIVER TO
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <T variant="body" weight="semibold" tone="onBrand" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {address ?? 'Set your location'}
                </T>
                <Feather name="chevron-down" size={16} color={color.white} />
              </View>
            </Pressable>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Pressable onPress={() => navigation.navigate('Notifications')} hitSlop={8}>
                <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' }}>
                  <Feather name="bell" size={18} color={color.white} />
                </View>
              </Pressable>
              <Pressable onPress={() => navigation.navigate('Tabs', { screen: 'Profile' })}>
                {user?.avatar ? (
                  <Image
                    source={{ uri: user.avatar }}
                    style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.brand[50] }}
                  />
                ) : (
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.surface.base, alignItems: 'center', justifyContent: 'center' }}>
                    <T variant="body" weight="bold" tone="brand">
                      {(user?.firstName?.[0] ?? 'S').toUpperCase()}
                    </T>
                  </View>
                )}
              </Pressable>
            </View>
          </View>

          {/* Search — the front door on every super app */}
          <Pressable onPress={() => navigation.navigate('Search')} style={{ marginTop: space.lg }}>
            {({ pressed }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  height: 46,
                  borderRadius: 9999,
                  paddingHorizontal: space.lg,
                  backgroundColor: color.surface.base,
                  opacity: pressed ? 0.92 : 1,
                }}
              >
                <Feather name="search" size={17} color={color.text.muted} />
                <T variant="label" tone="muted">
                  Restaurants, groceries, dishes…
                </T>
              </View>
            )}
          </Pressable>
        </View>

        {/* THE services grid — first thing under the header, 4x2, drawn icons */}
        <View
          style={{
            marginHorizontal: GUTTER,
            marginTop: -space.md,
            borderRadius: radius.xl,
            backgroundColor: color.surface.base,
            paddingBottom: space.lg,
            paddingHorizontal: space.sm,
            flexDirection: 'row',
            flexWrap: 'wrap',
            boxShadow: '0px 4px 12px rgba(33,26,26,0.06)',
            elevation: 3,
          }}
        >
          {SERVICES.map((s) => (
            <ServiceTile key={s.key} item={s} navigation={navigation} />
          ))}
        </View>

        {/* Live order first — the thing you actually care about right now */}
        {activeOrder ? (
          <View style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
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
          </View>
        ) : null}

        {/* Tier 1 — hero video slot (§13.1). Present only when sold+live. */}
        {heroAd ? (
          <View style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}>
            <AdHeroVideo item={heroAd} trackable={adTrackable} />
          </View>
        ) : null}

        {home.isLoading ? (
          <LoadingBlock style={{ paddingTop: 96 }} />
        ) : home.isError ? (
          <ErrorState onRetry={() => home.refetch()} style={{ paddingTop: 48 }} />
        ) : (
          <>
            {/* Order again — the fastest path to the next order */}
            {orderAgain.length > 0 ? (
              <>
                <SectionHeader
                  title="Order again"
                  onSeeAll={() => navigation.navigate('Tabs', { screen: 'Activity' })}
                  style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
                />
                <FlatList
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  data={orderAgain}
                  keyExtractor={(v: any) => v.id}
                  contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                  renderItem={({ item: v }) => (
                    <FoodCard
                      width={RAIL_CARD_W}
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
            ) : null}

            {/* Honest promo — 0% fees is the business model, not marketing */}
            <View style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}>
              <PromoBanner
                title="0% fees"
                sub="No markups — pay cash on delivery."
                cta="Order Now"
                image={FOOD_IMAGES[2]}
                onPress={() => navigation.navigate('Search')}
              />
            </View>

            {/* Tier 2 — top card slot (§13.2), the widget-row area. */}
            {topAd ? (
              <View style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}>
                <AdTopCard item={topAd} trackable={adTrackable} />
              </View>
            ) : null}

            {/* Find by Category */}
            {categories.length > 0 ? (
              <>
                <SectionHeader
                  title="Find by Category"
                  onSeeAll={() => navigation.navigate('Search')}
                  style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
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

            {/* Tier 3 — the rotating ad bar (§13.3). */}
            {barSlot && barSlot.items.length > 0 ? (
              <View style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}>
                <AdBar
                  items={barSlot.items}
                  rotationSeconds={barSlot.rotationSeconds}
                  trackable={adTrackable}
                  width={SCREEN_W - GUTTER * 2}
                />
              </View>
            ) : null}

            {/* Recommended — dense horizontal rail (Grab rails, not a sparse grid) */}
            <SectionHeader
              title="Recommended for you"
              onSeeAll={() => navigation.navigate('Recommended')}
              style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
            />
            {featured.length === 0 ? (
              <T variant="label" tone="muted" style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
                No open restaurants right now — check back soon.
              </T>
            ) : (
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={featured.slice(0, 10)}
                keyExtractor={(v: any) => v.id}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item: v }) => (
                  <FoodCard
                    width={RAIL_CARD_W}
                    image={vendorImage(v)}
                    name={v.name}
                    rating={Number(v.averageRating) || 0}
                    meta={[v.etaMin ? `${v.etaMin} min` : null, kmLabel(v.distanceKm)].filter(Boolean).join(' · ') || undefined}
                    favorite={v.isFavorite}
                    onToggleFavorite={() => onFavorite(v.id, !!v.isFavorite)}
                    onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                  />
                )}
              />
            )}

            {/* Nearby — only when location produced results (no fake proximity) */}
            {nearby.length > 0 ? (
              <>
                <SectionHeader
                  title="Nearby"
                  onSeeAll={() => navigation.navigate('Nearby')}
                  style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
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
                          extra={[v.etaMin ? `${v.etaMin} min` : null, kmLabel(v.distanceKm)].filter(Boolean).join(' · ') || undefined}
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
                    style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
                  />
                  <FlatList
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    data={shops.slice(0, 8)}
                    keyExtractor={(v: any) => v.id}
                    contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                    renderItem={({ item: v }) => (
                      <FoodCard
                        width={RAIL_CARD_W}
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
