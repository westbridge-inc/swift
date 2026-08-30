/** @jsxImportSource react */
import React, { useState } from 'react';
import { Dimensions, FlatList, Linking, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_URL } from '../../../services/api';
import { color, radius, space } from '@swift/ui';
import { useDiscoveryCategories, useHome, useToggleFavorite } from '../../../hooks/customer';
import { useAds } from '../../../hooks/ads';
import { AdHeroVideo, AdTopCard, AdBar } from '../../../components/ads';
import { PressableScale } from '../../../kit/pressable-scale';
import { Scrim } from '../../../kit/scrim';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { locationPrimer } from '../../../lib/location-primer';
import { useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { haptic } from '../../../lib/haptics';
import { useAuthStore } from '../../../stores/authStore';
import { useLocationStore } from '../../../stores/locationStore';
import { CategoryRail, CAT_RAIL_MIN_CHIPS } from '../CategoryRail';
// [F-264] itemPhoto/vendorPhoto return null rather than inventing a stock
// photo. `itemImage` used to hand "Mauby" a picture of a cheeseburger.
import { categoryPhoto, itemPhoto, vendorPhoto } from '../../../lib/images';
import { money } from '../../../lib/money';
import { orderStatusLabel, orderSubtitle } from '../../../lib/orderStatus';
import { promiseLine } from '../../../lib/promise';
// ONE hold authority, shared with the tracking screen — never a second
// countdown that could disagree with it about whether the window is open.
import { holdRingActive, holdRingWindow } from '../../../kit/hold-window';
import {
  Card,
  ErrorState,
  FoodCard,
  LoadingBlock,
  MerchantCard,
  Photo,
  Pictogram,
  type PictogramName,
  PillButton,
  RatingMeta,
  SectionHeader,
  T,
  VendorRow,
} from '../../../kit';
// Per-vertical identity colour lives in the KIT [F-263] — it was a local hex
// map here once and the no-literal-hex-in-screens rule cleaned it away, which
// is how the grid ended up as eight identical squares.

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const RAIL_CARD_W = Math.round(SCREEN_W * 0.44);
// The featured MERCHANT rail is deliberately larger than the dish rail
// [F-263]. Both were 44% wide, so a whole restaurant read exactly like one
// plate of food and the eye had nothing to rank. Wide enough that the next
// card peeks and the rail reads as scrollable without a carousel indicator.
const HERO_CARD_W = Math.round(SCREEN_W * 0.72);


// The super-app grid (Grab anatomy): every service one tap from the top of
// Home. Icons are the Swift pictogram set (design-100× 9.6) — one hand, never
// glyph-font clipart, never emoji. All destinations are REAL routes.
// [MKT-2] "Shops" is NOT here any more, and that is the point: goods got
// promoted from a tile to the Market tab. Orders opens the OrdersHistory stack
// screen directly, because the Activity tab it used to jump to no longer exists
// (the same history is also in Profile -> My orders).
//
// [SCAN-1] The eighth tile is Scan, and it is NOT Shops returning — MKT-2's
// decision stands, goods still live in the Market tab. Scan is here because the
// vendor dashboard has told stores "Customers scan this to order" since the QR
// feature shipped while the customer app had no scanner, and because
// POST /qr/:code/app-open exists to record an in-app open and had no caller.
// It is a door onto something already built, not a new destination.
const SERVICES: {
  key: PictogramName;
  label: string;
  nav: (n: any) => void;
}[] = [
  { key: 'food', label: 'Food', nav: (n) => n.navigate('Search', { type: 'RESTAURANT' }) },
  { key: 'groceries', label: 'Groceries', nav: (n) => n.navigate('Search', { type: 'SUPERMARKET' }) },
  { key: 'taxi', label: 'Taxi', nav: (n) => n.navigate('Taxi') },
  { key: 'send', label: 'Send', nav: (n) => n.navigate('Courier') },
  { key: 'services', label: 'Services', nav: (n) => n.navigate('Services') },
  { key: 'orders', label: 'Orders', nav: (n) => n.navigate('OrdersHistory') },
  { key: 'favourites', label: 'Favourites', nav: (n) => n.navigate('Favorites') },
  { key: 'scan', label: 'Scan', nav: (n) => n.navigate('Scan') },
];

// Status wording moved to lib/orderStatus.ts: it has to know the order
// TYPE. This map had six entries, one of which (READY) was never a status —
// the enum value is READY_FOR_PICKUP — and it described a taxi ride as
// "Waiting for the store".

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
  // ONE ACCENT, NOT EIGHT [100x pass §5, Home v2].
  //
  // The grid used to give every service its own hue off the F-263 ramp. The
  // pass retires that: "the 8-tint tile salad is gone: every service sits on
  // one quiet ground with ink pictograms; Food alone wears the brand fill —
  // the flagship reads as the flagship, and the screen stops vibrating."
  // Logged there as a founder decision that supersedes F-263.
  //
  // So the hierarchy is carried by ONE tile instead of eight competing ones:
  // the flagship is filled and its glyph reverses out; everything else is an
  // ink pictogram on the same quiet ground. Nothing here invents a colour —
  // the flagship's fill is the brand, and the ground is a surface token.
  const isFlagship = item.key === 'food';
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
      style={{ width: '100%', alignItems: 'center', marginTop: space.md }}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.lg,
          // [Wave 3 audit vs reference 03] `sunken`, NOT `subtle`. The decision
          // above is right and stands — one accent, a quiet ground for the rest.
          // It just never rendered: `surface.subtle` IS the page colour (the
          // token file calls it "paper — the app background", and this screen
          // paints its own background with it), so the seven quiet tiles were
          // painted the same colour as the paper behind them and had no ground
          // at all. `sunken` is the token for exactly this — "grouped sections
          // / tracks — 3% brand tint on paper" — and it is what the reference
          // shows. A ground you cannot see is not a quiet ground; it is a
          // missing one.
          backgroundColor: isFlagship ? color.brand[500] : color.surface.sunken,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Pictogram name={item.key} size={28} color={isFlagship ? color.white : color.text.primary} />
      </View>
      <T variant="label" style={{ marginTop: 6 }}>
        {item.label}
      </T>
    </PressableScale>
    </Animated.View>
  );
}

/**
 * The live order, as Home shows it.
 *
 * Two things it must never do. It must never describe the order with the wrong
 * vertical's words — `orderStatusLabel` needs `orderType`, and Home's feed did
 * not send it, so every order read as a food order. And it must never invent
 * the hold: the countdown comes from `holdRingWindow`, the same seam the
 * tracking screen uses, which returns null unless BOTH ends of the window
 * arrived from the server. No local five-minute assumption, one authority.
 */
function LiveOrderCard({ order, navigation }: { order: any; navigation: any }) {
  // Tick ONLY while a hold is actually running. `holdRingWindow` is pure, so
  // re-evaluating it against a fresh `now` is the whole animation; when the
  // window closes the interval clears itself and the card goes quiet.
  const [now, setNow] = useState(() => Date.now());
  const holdRunning = holdRingActive(order.holdExpiresAt, now, false);
  React.useEffect(() => {
    if (!holdRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [holdRunning]);

  const hold = holdRingWindow(order.holdExpiresAt, order.placedAt, now, false);
  const remaining = hold ? Math.ceil(hold.remainingMs / 1000) : 0;
  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  // [ALG-12] The promise range from the server (Home is cached ~60 s, so the
  // range is an absolute window and stays true out of the cache); a passed
  // window is never shown as still coming.
  const promise = promiseLine(order.promise, now);

  return (
    <View style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  // Amber while held: this is a state with something to DO in
                  // it, not the green "everything is proceeding" of an order
                  // already with the store.
                  backgroundColor: hold ? color.warning : color.success,
                }}
              />
              <T variant="body" weight="semibold">
                {hold
                  ? `Held — goes to ${order.vendor?.name ?? 'the store'} in ${mmss}`
                  : orderStatusLabel(order.status, order.orderType)}
              </T>
            </View>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              {hold
                ? // NOT "cancel free until then" [REPORT-011 F-02 / INV-7]: the
                  // server owns the timer, a skewed device clock can keep this
                  // card alive past the real window, and promising "free" from
                  // that clock is the app making a money claim it cannot keep.
                  // What stays true on any clock is that the store has not been
                  // told yet — the cost, if any, is shown before confirming.
                  `The store hasn’t been told yet · ${orderSubtitle(null, order.orderNumber)}`
                : orderSubtitle(order.vendor?.name, order.orderNumber)}
            </T>
            {promise && !hold ? (
              <T variant="caption" style={{ marginTop: 4 }}>
                {promise.label}
              </T>
            ) : null}
          </View>
          <PillButton
            // [Wave 3 vs reference 03] "Track", both states — the reference and
            // the rendered prototype use the one word for the held card too
            // (the tracking screen is where the hold ceremony lives), and
            // nothing on file defended the old "Review".
            label="Track"
            variant="dark"
            size="sm"
            onPress={() => navigation.navigate('Delivery', { orderId: order.id })}
          />
        </View>

        {/* The window, drawn. `progress` is remaining/total from the server's
            own two timestamps — it is not a duration this screen assumed.
            The TRACK takes `sunken`, the same correction as the tiles: at
            `subtle` on a white card it was a 0.4% difference from its own
            card, so the window read as a floating maroon bar with no channel
            and "how much is left" lost its reference edge. */}
        {hold ? (
          // [Wave 3 vs reference 03] The reference draws a DOT riding the fill's
          // leading edge — the "where we are" marker a thin bar alone doesn't
          // give. Overflow stays visible so the 8dp dot can sit proud of the
          // 4dp track, exactly as drawn.
          <View style={{ height: 4, borderRadius: 2, backgroundColor: color.surface.sunken }}>
            <View
              style={{
                width: `${Math.round(hold.progress * 100)}%`,
                height: '100%',
                borderRadius: 2,
                backgroundColor: color.warning,
              }}
            />
            <View
              style={{
                position: 'absolute',
                left: `${Math.round(hold.progress * 100)}%`,
                top: -2,
                marginLeft: -4,
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: color.warning,
              }}
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
}

export function HomeScreen() {
  const [avatarBroken, setAvatarBroken] = useState(false);
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, promptLogin } = useAuthStore();
  // [REPORT-022 F-022-18] clear the failure latch when the URL changes.
  React.useEffect(() => { setAvatarBroken(false); }, [user?.avatar]);
  const { latitude, longitude, address, status } = useLocationStore();
  // refreshOnMount:false — App.tsx already owns the silent boot refresh; this
  // hook is here ONLY to hand the primer its explicit, user-initiated request.
  const { resolve: requestLocation } = useDeviceLocation({ refreshOnMount: false });
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
  const popularItems: any[] = feed?.popularItems ?? [];
  const nearby: any[] = locationFix ? (feed?.nearby ?? []) : [];
  // One tested table decides this (lib/location-primer) — the screen must not
  // grow a second opinion about when it is legitimate to ask for location.
  const primer = locationPrimer(locationFix !== null, status);
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
      {/* THE HEADER IS FIXED [100x pass §5, "Home v2 — Uber-grade discipline"].
          It used to live inside the ScrollView, so the greeting slid up under
          the status-bar clock the moment you scrolled — the collision the pass
          calls out by name. Now: location pill → greeting → search stay put,
          and the content scrolls underneath them.

          The ORDER is the pass's, and it is the other way round from what
          shipped. Where you are is the first decision on a delivery home
          screen — it decides which stores can even reach you — so the pill
          leads, the greeting follows as the one display-face line, and search
          closes the block. */}
      {/* THE CHROME IS PAPER, NOT BRAND — read off the rendered design slides.
          Home had a full-bleed maroon gradient slab holding a white greeting
          and a white search pill. There is no such slab in the design: the top
          of the screen is the same warm paper as the rest of it, with a
          hairline-bordered location pill, an INK greeting, and a white search
          field. This is the difference that made every earlier fix still look
          the same — the furniture kept moving inside a room that shouldn't
          exist. `GradientMasthead` is NOT deleted and is still exported from the kit (FG-2), but this screen was the last caller: it now has ZERO call sites app-wide and is dead code awaiting a founder decision. Logged as an FG-2 deletion candidate — not removed here. */}
      <View style={{ paddingTop: insets.top, paddingBottom: space.lg, paddingHorizontal: GUTTER, backgroundColor: color.surface.subtle }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Pressable
            onPress={() => (isAuthenticated ? navigation.navigate('Addresses') : navigation.navigate('LocationPicker'))}
            style={{ paddingRight: space.md, flexShrink: 1 }}
            accessibilityRole="button"
            accessibilityLabel={locationFix ? `Delivery location: ${address ?? 'current location'}` : 'Set your location'}
          >
            {/* A PILL, not a bare label — hairline border, paper fill. It reads
                as the control it is, which also stops "Set your location" from
                looking like an address someone already filled in. */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                alignSelf: 'flex-start',
                paddingVertical: space.xs,
                paddingHorizontal: space.md,
                borderRadius: radius.full,
                borderWidth: 1,
                borderColor: color.border.subtle,
                backgroundColor: color.surface.base,
              }}
            >
              <Feather name="map-pin" size={14} color={color.text.primary} />
              <T variant="label" weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
                {locationFix ? (address ?? 'Current location') : 'Set your location'}
              </T>
              <Feather name="chevron-down" size={15} color={color.text.muted} />
            </View>
          </Pressable>
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              {/* The bell loses its filled circle but KEEPS a 44pt target —
                  hitSlop compensates for the smaller glyph, or this becomes a
                  36pt tap area and fails the accessibility minimum. */}
              <Pressable
                onPress={() => navigation.navigate('Notifications')}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel="Notifications"
              >
                <Feather name="bell" size={22} color={color.text.primary} />
              </Pressable>
              <Pressable
                onPress={() => navigation.navigate('Tabs', { screen: 'Profile' })}
                accessibilityRole="button"
                accessibilityLabel="Profile"
              >
                {user?.avatar && !avatarBroken ? (
                  <Image
                    source={{ uri: /^https?:\/\//.test(user.avatar) ? user.avatar : `${API_URL}${user.avatar}` }}
                    // A dead/expired avatar URL must never leave a nameless
                    // blank circle — fall back to the monogram [visual pass 08-19].
                    onError={() => setAvatarBroken(true)}
                    style={{ width: 40, height: 40, borderRadius: radius.full, backgroundColor: color.brand[50] }}
                  />
                ) : (
                  <View style={{ width: 40, height: 40, borderRadius: radius.full, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
                    <T variant="body" weight="bold" tone="brand">
                      {(user?.firstName?.[0] ?? 'S').toUpperCase()}
                    </T>
                  </View>
                )}
              </Pressable>
          </View>
        </View>

        {/* Home's ONE display-face line — now in INK, on paper. */}
        <T variant="title" numberOfLines={1} style={{ marginTop: space.md }}>
          {greetingLine(new Date().getHours())}
          {user?.firstName?.trim() ? `, ${user.firstName.trim()}` : ''}
        </T>

        {/* Search — the front door on every super app. White field, hairline
            border: on paper it needs an edge to read as a field at all. */}
        <Pressable
          onPress={() => navigation.navigate('Search')}
          style={{ marginTop: space.md }}
          accessibilityRole="search"
          accessibilityLabel="Search restaurants, groceries and dishes"
        >
          {({ pressed }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                height: 48,
                borderRadius: radius.full,
                paddingHorizontal: space.lg,
                backgroundColor: color.surface.base,
                borderWidth: 1,
                borderColor: color.border.subtle,
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

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space['3xl'] }}
        refreshControl={
          // The pull now happens on paper, not on the maroon wash, so the
          // spinner has to be brand — white on white is an invisible spinner.
          <RefreshControl refreshing={home.isRefetching} onRefresh={() => home.refetch()} tintColor={color.brand[500]} />
        }
      >
        {/* THE LIVE ORDER, FIRST — and it used to say so while rendering fourth.
            This block carried the comment "Live order first — the thing you
            actually care about right now" from a position BELOW the tiles, below
            the popular rail and below the category rail. On a phone that put a
            running order under a horizontally-scrolling food carousel, off the
            bottom of the screen.

            It matters most in the hold. For the length of the hold window the
            store has not been told about this order yet, and cancelling costs
            nothing — that window is the whole basis of the cancellation policy,
            and a customer cannot act on a window they have to scroll to find.

            The marketplace-first decision below is NOT reversed: with no live
            order this renders nothing and the food is still the first thing on
            Home. An order in flight is not a launcher tile — it is transient,
            it is timed, and while it exists it outranks browsing. */}
        {activeOrder ? <LiveOrderCard order={activeOrder} navigation={navigation} /> : null}

        {/* THE services grid — 4x2, drawn icons, ON OPEN PAPER.
            [100x pass §5/§6] "hairline rows on open paper (no card chassis)".
            This grid used to sit in a floating white card with a shadow, which
            is the single thing that made Home read as a launcher panel rather
            than a marketplace: a chassis draws a box around navigation and
            announces it as the subject. The tiles are the subject; the box was
            furniture. Same tiles, same spacing — the container is just gone. */}
        <View
          style={{
            marginHorizontal: GUTTER,
            marginTop: space.lg,
            paddingBottom: space.md,
            flexDirection: 'row',
            flexWrap: 'wrap',
          }}
        >
          {SERVICES.map((s, i) => (
            <ServiceTile key={s.key} item={s} index={i} navigation={navigation} />
          ))}
        </View>

        {/* THE MARKETPLACE, above the fold.
            Home used to open as a LAUNCHER: a masthead slab, eight identical
            tiles, a promo and some text chips — with the first real merchant
            content roughly a screen and a half down. Meanwhile /customer/home
            already returns ten dishes with photography and prices, and this
            screen fetched them and threw them away (only Search rendered
            them). A marketplace has to look like one the moment it opens, so
            the food goes first and the icon grid becomes what it always was:
            navigation. */}
        {popularItems.length > 0 ? (
          <>
            {/* NEITHER OF THESE USED TO BE TRUE. The rail was headed "Popular
                right now" under the eyebrow "Ordered today" — two separate
                time claims over a rail ordered by `Item.totalOrdered`, which
                has exactly one writer (order.service.ts: `increment: 1`), is
                never decremented, is never reset, and has no time window
                anywhere in the schema. It is a LIFETIME counter. A dish sold
                two hundred times last year and never since outranked one
                selling all morning, and the screen called that "today".

                The counter is a real signal — it is just an all-time one, so
                the words now say all-time. Building the honest "today" version
                needs a time-windowed counter that does not exist yet; that is
                a schema change, not a copy change, and it is not smuggled in
                behind a label. */}
            <SectionHeader
              size="lg"
              title="Popular on Swift"
              eyebrow="Most ordered"
              // [Wave 3 vs reference 03] The reference gives this rail a
              // "See all"; Search is the app's real all-items door.
              onSeeAll={() => navigation.navigate('Search')}
              style={{ paddingHorizontal: GUTTER, marginTop: space.xl }}
            />
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={popularItems.slice(0, 10)}
              keyExtractor={(it: any) => it.id}
              contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
              renderItem={({ item: it }) => (
                <FoodCard
                  width={RAIL_CARD_W}
                  image={itemPhoto(it)}
                  name={it.name}
                  priceLabel={money(it.price)}
                  // [Wave 3 vs reference 03 · #941] "Vendor · 25 min" — the
                  // vendor's own enrichVendor ETA now rides popularItems;
                  // null (no buyer position) says nothing, never a guess.
                  meta={[it.vendorName, it.etaMin != null ? `${it.etaMin} min` : null].filter(Boolean).join(' · ')}
                  onPress={() => navigation.navigate('MenuItem', { itemId: it.id, vendorId: it.vendorId })}
                />
              )}
            />
          </>
        ) : null}

        {/* The category rail — the founder's X: below the tiles, above the
            promo banner. Absent entirely unless the flag is on AND ≥4 chips
            have open stores behind them (laws D/E). */}
        <CategoryRail
          data={discovery.data}
          loading={false}
          onChip={(c) => navigation.navigate('CategoryFeed', { slug: c.slug, name: c.name, emoji: c.emoji })}
          onSeeAll={() => navigation.navigate('CategoryGrid')}
        />

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
                  onSeeAll={() => navigation.navigate('OrdersHistory')}
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
                      image={vendorPhoto(v)}
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
              {/* 0% FEES — ONE QUIET ROW [100x pass §5: "the 0% fees line, now
                  one quiet row"]. It was a full brand-filled promo banner with
                  a CTA, which made Swift's most credible claim look like an ad
                  — and an ad is the one thing nobody believes. Stated plainly
                  on paper, in ink, it reads as a fact about how Swift works,
                  which is what it is. No CTA: it is not selling anything. */}
              <View style={{ paddingHorizontal: GUTTER, flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                <Feather name="check-circle" size={16} color={color.success} style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <T variant="bodyStrong">0% fees, always.</T>
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    Swift never marks up your order — pay cash when it arrives.
                  </T>
                </View>
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
                    // [Founder 08-22] Bare outlined text pills were the last
                    // clean-minimal islands on the screen. Categories are FOOD
                    // — they get photography with a scrim and white label,
                    // like every other band. Real menu categories from the
                    // live feed; the merchant's own imagery via categoryPhoto.
                    <Pressable
                      onPress={() => navigation.navigate('Search', { q: item.name })}
                      accessibilityRole="button"
                      accessibilityLabel={item.name}
                    >
                      {({ pressed }) => (
                        <View style={{ width: 132, height: 84, borderRadius: radius.lg, overflow: 'hidden', opacity: pressed ? 0.85 : 1 }}>
                          {/* The merchant's own picture. This passed
                              categoryImage(name), which looked the name up in a
                              map keyed by VERTICAL — food, grocery, taxi — and
                              returned a stock photo when it missed. Menu
                              categories never match, so every chip on Home was
                              the same photograph. Photo already draws an honest
                              placeholder for null; it was simply never given one. */}
                          <Photo uri={categoryPhoto(item)} label={item.name} style={{ width: '100%', height: '100%' }} />
                          <Scrim height={84} cover />
                          <View style={{ position: 'absolute', left: space.md, right: space.md, bottom: space.sm }}>
                            <T variant="label" weight="semibold" tone="onBrand" numberOfLines={1}>{item.name}</T>
                          </View>
                        </View>
                      )}
                    </Pressable>
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
                  <MerchantCard
                    width={HERO_CARD_W}
                    image={vendorPhoto(v)}
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

            {/* No location ⇒ the marketplace has NO local dimension: `nearby`
                comes back empty, distances are unknowable, and the only clue
                used to be a passive "Set your location" label in the masthead.
                On a hyperlocal marketplace that is the difference between
                "what's open around me" and a catalogue. So the ask lives HERE,
                in the gap it explains, priced in what the user gets — never a
                boot-time OS dialog (BOOT_LOCATION_MODE stays 'silent') and
                never a nag above content that works fine without it. */}
            {primer.show ? (
              <Card style={{ marginHorizontal: GUTTER, marginTop: space['2xl'], flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="map-pin" size={20} color={color.brand[600]} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="label" weight="semibold">
                    {primer.action === 'settings' ? 'Location is off' : 'See what’s open around you'}
                  </T>
                  <T variant="micro" tone="muted">
                    {primer.action === 'none'
                      ? 'Finding you now — keep browsing while we look.'
                      : 'Sorted by what’s closest to you. Browsing works without it.'}
                  </T>
                </View>
                {primer.action === 'none' ? null : (
                  <PillButton
                    size="sm"
                    label={primer.action === 'settings' ? 'Settings' : 'Use location'}
                    onPress={() => {
                      haptic.select();
                      if (primer.action === 'settings') void Linking.openSettings();
                      else void requestLocation();
                    }}
                  />
                )}
              </Card>
            ) : null}

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
                      image={vendorPhoto(v)}
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
                        image={vendorPhoto(v)}
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

            {/* Closed now — the server computes and ships up to 10 of these and
                Home used to DISCARD them (F-256), which is why the marketplace
                looked thin off-hours: Georgetown late night and Sunday are a
                large share of the week, and hiding every shut merchant makes a
                real catalogue read as an empty one. Shown last, dimmed, never
                mixed into the orderable rails — VendorRow's `closed` state
                already says "Closed right now" and labels it for screen
                readers. Tapping still opens the store: hours, menu and
                favouriting are all worth having before it opens. */}
            {(() => {
              const closedVendors: any[] = feed?.closedVendors ?? [];
              if (closedVendors.length === 0) return null;
              return (
                <>
                  <SectionHeader
                    size="lg"
                    title="Closed now"
                    eyebrow="Browse ahead"
                    style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }}
                  />
                  <View style={{ paddingHorizontal: GUTTER, paddingTop: space.lg, gap: space.md }}>
                    {closedVendors.slice(0, 4).map((v: any) => (
                      <VendorRow
                        key={v.id}
                        closed
                        image={vendorPhoto(v)}
                        name={v.name}
                        meta={
                          <RatingMeta
                            rating={v.displayRating ?? null}
                            bucket={v.ratingBucket}
                            topRated={v.topRated}
                            extra={locationFix ? kmLabel(v.distanceKm) : undefined}
                          />
                        }
                        onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                      />
                    ))}
                  </View>
                </>
              );
            })()}
          </>
        )}
      </ScrollView>
    </View>
  );
}
