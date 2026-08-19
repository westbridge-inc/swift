/** @jsxImportSource react */
import React from 'react';
import { Dimensions, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, radius, space } from '@swift/ui';
import { useDiscoveryCategories, useHome, useToggleFavorite } from '../../../hooks/customer';
import { useAds } from '../../../hooks/ads';
import { AdHeroVideo, AdTopCard, AdBar } from '../../../components/ads';
import { PressableScale } from '../../../components/ui';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { haptic } from '../../../lib/haptics';
import { useAuthStore } from '../../../stores/authStore';
import { useLocationStore } from '../../../stores/locationStore';
import { CategoryRail, CAT_RAIL_MIN_CHIPS } from '../CategoryRail';
import { vendorImage } from '../../../lib/images';
import {
  AwningEdge,
  Card,
  Chip,
  ErrorState,
  FoodCard,
  GradientMasthead,
  LoadingBlock,
  Pictogram,
  type PictogramName,
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

// The super-app grid (Grab anatomy): every service one tap from the top of
// Home. Icons are the Swift pictogram set (design-100× 9.6) — one hand, never
// glyph-font clipart, never emoji. All destinations are REAL routes.
const SERVICES: {
  key: PictogramName;
  label: string;
  nav: (n: any) => void;
}[] = [
  { key: 'food', label: 'Food', nav: (n) => n.navigate('Search', { type: 'RESTAURANT' }) },
  { key: 'groceries', label: 'Groceries', nav: (n) => n.navigate('Search', { type: 'SUPERMARKET' }) },
  { key: 'shops', label: 'Shops', nav: (n) => n.navigate('Search', { type: 'STORE' }) },
  { key: 'taxi', label: 'Taxi', nav: (n) => n.navigate('Taxi') },
  { key: 'send', label: 'Send', nav: (n) => n.navigate('Courier') },
  { key: 'services', label: 'Services', nav: (n) => n.navigate('Services') },
  { key: 'orders', label: 'Orders', nav: (n) => n.navigate('Tabs', { screen: 'Activity' }) },
  { key: 'favourites', label: 'Favourites', nav: (n) => n.navigate('Favorites') },
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

/** The one display-face moment on Home [DESIGN_NOTES 2026-08-18]: a
 *  time-aware greeting — Guyana is a single timezone, the device clock is
 *  the honest source. */
function greetingLine(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function ServiceTile({ item, index, navigation }: { item: (typeof SERVICES)[number]; index: number; navigation: any }) {
  return (
    // First-paint stagger [design-100x 9.4 `gentle`]: opacity + a 4dp rise,
    // once per mount, honoring the system reduced-motion setting.
    <Animated.View
      entering={FadeInDown.duration(320).delay(index * 40).reduceMotion(ReduceMotion.System)}
      style={{ width: '25%' }}
    >
    <PressableScale
      strong
      onPress={() => {
        haptic.select();
        item.nav(navigation);
      }}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      style={{ width: '100%', alignItems: 'center', marginTop: space.lg }}
    >
      <View
        style={{
          width: 58,
          height: 58,
          borderRadius: radius.lg,
          backgroundColor: color.brand[50],
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Pictogram name={item.key} size={28} color={color.brand[600]} />
      </View>
      <T variant="label" style={{ marginTop: 6 }}>
        {item.label}
      </T>
    </PressableScale>
    </Animated.View>
  );
}

export function HomeScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, promptLogin } = useAuthStore();
  const { latitude, longitude, address, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);

  const home = useHome<any>(locationFix?.latitude, locationFix?.longitude);
  const toggleFav = useToggleFavorite();
  // Category rail (#17): flag-gated server-side; when live it SUPERSEDES the
  // old "Find by category" section (one category system on Home, ever —
  // spec 6.2). Flag off → both absent/present exactly as before (CAT-G).
  const discovery = useDiscoveryCategories(locationFix?.latitude, locationFix?.longitude);
  const railLive = !!discovery.data?.enabled && (discovery.data?.categories.length ?? 0) >= CAT_RAIL_MIN_CHIPS;

  // Ads hydrate independently (§13.4): home content NEVER waits on this call,
  // and an ad-free answer collapses the slots so sections close up. Launch is
  // single-city → "*" everywhere (E11).
  const ads = useAds('*');
  const adSlots = ads.data?.data?.placements;
  const adTrackable = ads.data?.trackable ?? false;
  const adTrackingScope = ads.data?.trackingScope ?? null;
  const adTrackingKey = adTrackingScope
    ? `${adTrackingScope.kind}:${adTrackingScope.scopeId}:${adTrackingScope.generation}`
    : 'display-only';
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
  const nearby: any[] = locationFix ? (feed?.nearby ?? []) : [];
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
        {/* The masthead [DESIGN_NOTES 2026-08-18]: the brand wash deepens
            500→600 and closes with the awning hem — Home's signature. Where +
            who as the eyebrow, ONE display-face greeting, then search. */}
        <GradientMasthead style={{ paddingTop: insets.top + space.sm, paddingBottom: space.xl, paddingHorizontal: GUTTER }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable
              onPress={() => (isAuthenticated ? navigation.navigate('Addresses') : navigation.navigate('LocationPicker'))}
              style={{ flex: 1, paddingRight: space.md }}
            >
              <T variant="micro" tone="onBrand" style={{ opacity: 0.72 }}>
                Deliver to
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <T variant="body" weight="semibold" tone="onBrand" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {locationFix ? (address ?? 'Current location') : 'Set your location'}
                </T>
                <Feather name="chevron-down" size={16} color={color.white} />
              </View>
            </Pressable>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Pressable onPress={() => navigation.navigate('Notifications')} hitSlop={8}>
                <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.onBrand }}>
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

          <T variant="title" tone="onBrand" numberOfLines={1} style={{ marginTop: space.lg }}>
            {greetingLine(new Date().getHours())}
            {user?.firstName?.trim() ? `, ${user.firstName.trim()}` : ''}
          </T>

          {/* Search — the front door on every super app */}
          <Pressable onPress={() => navigation.navigate('Search')} style={{ marginTop: space.md }}>
            {({ pressed }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  height: 52,
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
        </GradientMasthead>
        <AwningEdge />

        {/* THE services grid — the shelf under the awning: 4x2, drawn icons */}
        <View
          style={{
            marginHorizontal: GUTTER,
            marginTop: space.sm,
            borderRadius: radius.xl,
            backgroundColor: color.surface.base,
            paddingBottom: space.lg,
            paddingHorizontal: space.sm,
            flexDirection: 'row',
            flexWrap: 'wrap',
            ...elevation.card,
          }}
        >
          {SERVICES.map((s, i) => (
            <ServiceTile key={s.key} item={s} index={i} navigation={navigation} />
          ))}
        </View>

        {/* The category rail — the founder's X: below the tiles, above the
            promo banner. Absent entirely unless the flag is on AND ≥4 chips
            have open stores behind them (laws D/E). */}
        <CategoryRail
          data={discovery.data}
          loading={false}
          onChip={(c) => navigation.navigate('CategoryFeed', { slug: c.slug, name: c.name, emoji: c.emoji })}
          onSeeAll={() => navigation.navigate('CategoryGrid')}
        />

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
                label="Track order"
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
            <AdHeroVideo
              key={`hero:${adTrackingKey}`}
              item={heroAd}
              trackable={adTrackable}
              trackingScope={adTrackingScope}
            />
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
                  size="lg"
                  title="Order again"
                  eyebrow="From your orders"
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
                      rating={v.displayRating ?? null}
                      ratingBucket={v.ratingBucket}
                      topRated={v.topRated}
                      meta={v.etaMin ? `${v.etaMin} min` : undefined}
                      favorite={v.isFavorite}
                      onToggleFavorite={() => onFavorite(v.id, !!v.isFavorite)}
                      onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                    />
                  )}
                />
              </>
            ) : null}

            {/* The commercial band — house promo + sold placements grouped on
                the sunken surface so the rhythm reads: yours, theirs, then
                back to the food [DESIGN_NOTES 2026-08-18]. */}
            <View style={{ backgroundColor: color.surface.sunken, paddingVertical: space['2xl'], marginTop: space['2xl'] }}>
              {/* Honest promo — 0% fees is the business model, not marketing */}
              <View style={{ paddingHorizontal: GUTTER }}>
                <PromoBanner
                  variant="tint"
                  pictogram="orders"
                  title="0% fees, always"
                  sub="Swift never marks up your order. Pay cash when it arrives."
                  cta="Order now"
                  onPress={() => navigation.navigate('Search')}
                />
              </View>

              {/* Tier 2 — top card slot (§13.2), the widget-row area. */}
              {topAd ? (
                <View style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}>
                  <AdTopCard
                    key={`top:${adTrackingKey}`}
                    item={topAd}
                    trackable={adTrackable}
                    trackingScope={adTrackingScope}
                  />
                </View>
              ) : null}
            </View>

            {/* Find by Category — superseded by the rail when it is live
                (spec 6.2: one category system on Home, ever). */}
            {!railLive && categories.length > 0 ? (
              <>
                <SectionHeader
                  size="lg"
                  title="Find by category"
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
                  key={`bar:${adTrackingKey}`}
                  items={barSlot.items}
                  rotationSeconds={barSlot.rotationSeconds}
                  trackable={adTrackable}
                  trackingScope={adTrackingScope}
                  width={SCREEN_W - GUTTER * 2}
                />
              </View>
            ) : null}

            {/* Recommended — dense horizontal rail (Grab rails, not a sparse grid) */}
            <SectionHeader
              size="lg"
              title="Recommended for you"
              eyebrow="Open now"
              onSeeAll={() => navigation.navigate('Recommended')}
              style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
            />
            {featured.length === 0 ? (
              <T variant="label" tone="muted" style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
                Nothing's open right now — check back soon.
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
                    rating={v.displayRating ?? null}
                    ratingBucket={v.ratingBucket}
                    topRated={v.topRated}
                    meta={[
                      v.etaMin ? `${v.etaMin} min` : null,
                      locationFix ? kmLabel(v.distanceKm) : null,
                    ].filter(Boolean).join(' · ') || undefined}
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
                  size="lg"
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
                          rating={v.displayRating ?? null}
                          bucket={v.ratingBucket}
                          topRated={v.topRated}
                          extra={[
                            v.etaMin ? `${v.etaMin} min` : null,
                            locationFix ? kmLabel(v.distanceKm) : null,
                          ].filter(Boolean).join(' · ') || undefined}
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
                    size="lg"
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
                        rating={v.displayRating ?? null}
                        ratingBucket={v.ratingBucket}
                        topRated={v.topRated}
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
