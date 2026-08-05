/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Dimensions, FlatList, Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, font, radius, space } from '@swift/ui';
import { useAddToCart, useCart, useToggleFavorite, useUpdateCartItem, useVendor } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { DARK_BLURHASH, itemImage, vendorImage } from '../../../lib/images';
import { money } from '../../../lib/money';
import {
  AddMorph,
  Chip,
  CircleChip,
  ErrorState,
  FoodCard,
  HeartBadge,
  IconChip,
  LoadingBlock,
  MenuRow,
  Money,
  PillButton,
  PopupCard,
  SectionHeader,
  T,
  TonePill,
} from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const RAIL_W = 200;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hoursLabel(hours: any[] | undefined): string | null {
  if (!hours?.length) return null;
  const today = hours.find((h) => h.dayOfWeek === new Date().getDay());
  if (!today || today.isClosed) return 'Closed today';
  return `${today.openTime}–${today.closeTime}`;
}

/** Info-strip column: icon + value on top, muted caption beneath (kit 14). */
function StatCol({
  icon,
  value,
  caption,
  onPress,
  last = false,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  value: string;
  caption: string;
  onPress?: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        flex: 1,
        borderRightWidth: last ? 0 : 1,
        borderRightColor: color.border.subtle,
        paddingHorizontal: space.sm,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Feather name={icon} size={14} color={icon === 'star' ? color.star : color.brand[500]} />
        <T variant="label" weight="semibold" numberOfLines={1}>
          {value}
        </T>
      </View>
      <T variant="caption" tone={onPress ? 'brand' : 'muted'} numberOfLines={1}>
        {caption}
      </T>
    </Pressable>
  );
}

const TILE_W = (SCREEN_W - GUTTER * 2 - space.md * 2) / 3;

/** Mart product tile (Grab-Mart density): square photo, tight name, price +
 *  on-card add. In-cart shows a mini stepper — shopping without detail hops. */
function ProductTile({
  item,
  line,
  onAdd,
  onSetQty,
  onOpen,
  busy,
}: {
  item: any;
  line: any;
  onAdd: () => void;
  onSetQty: (qty: number) => void;
  onOpen: () => void;
  busy: boolean;
}) {
  const hasOptions = (item.optionGroups?.length ?? 0) > 0;
  const out = item.stockQuantity === 0;
  const qty = line?.quantity ?? 0;
  return (
    <View style={{ width: TILE_W }}>
      <Pressable onPress={onOpen}>
        <Image
          source={{ uri: itemImage(item) }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          transition={150}
          style={{ width: TILE_W, height: TILE_W, borderRadius: radius.md, backgroundColor: color.surface.base, opacity: out ? 0.5 : 1 }}
          contentFit="cover"
        />
      </Pressable>
      <T variant="caption" weight="medium" numberOfLines={2} style={{ marginTop: 6, minHeight: 32 }}>
        {item.name}
      </T>
      {item.unit ? (
        <T variant="caption" tone="faint" numberOfLines={1}>
          {item.unit}
        </T>
      ) : null}
      <View style={{ marginTop: 2, gap: 4 }}>
        <Money amount={item.customerPrice ?? item.basePrice} tone={out ? 'muted' : 'brand'} numberOfLines={1} />
        {out ? (
          <T variant="micro" tone="warning">
            Sold out
          </T>
        ) : (
          <View style={{ alignSelf: 'flex-end' }}>
            <AddMorph
              size="sm"
              qty={hasOptions ? 0 : qty}
              busy={busy}
              onAdd={hasOptions ? onOpen : onAdd}
              onInc={() => onSetQty(qty + 1)}
              onDec={() => onSetQty(qty - 1)}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** Service listing row: what it costs, how long it takes, where it happens —
 *  tapping opens the booking screen (slots), never a qty flow. */
function ServiceRow({ item, onOpen }: { item: any; onOpen: () => void }) {
  const cfg = (item.bookingConfig ?? {}) as { durationMinutes?: number; serviceMode?: string };
  const modeLabel =
    cfg.serviceMode === 'MOBILE' ? 'Comes to you' : cfg.serviceMode === 'BOTH' ? 'Your choice' : 'At their place';
  return (
    <Pressable onPress={onOpen}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            borderRadius: radius.lg,
            backgroundColor: pressed ? color.surface.subtle : color.surface.base,
            padding: space.md,
          }}
        >
          <Image
            source={{ uri: itemImage(item) }}
            placeholder={{ blurhash: DARK_BLURHASH }}
            style={{ width: 64, height: 64, borderRadius: radius.md }}
            contentFit="cover"
          />
          <View style={{ flex: 1 }}>
            <T variant="body" weight="semibold" numberOfLines={1}>
              {item.name}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 }}>
              {cfg.durationMinutes ? <TonePill label={`${cfg.durationMinutes} min`} tone="neutral" /> : null}
              <TonePill label={modeLabel} tone="brand" />
            </View>
            <View style={{ marginTop: 6, alignSelf: 'flex-start' }}>
              <Money amount={item.customerPrice ?? item.basePrice} tone="brand" />
            </View>
          </View>
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Feather name="calendar" size={18} color={color.brand[500]} />
            <T variant="caption" tone="brand" weight="semibold">
              Book
            </T>
          </View>
        </View>
      )}
    </Pressable>
  );
}

// Kit 14–20: cover hero + floating chips, white sheet w/ name + info strip,
// promos row, Recommended/Best-seller rails, then the full menu by category.
export function RestaurantScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const vendorId: string = route.params?.vendorId;
  const { isAuthenticated, promptLogin } = useAuthStore();

  const vendor = useVendor<any>(vendorId);
  const toggleFav = useToggleFavorite();
  const [showHours, setShowHours] = useState(false);
  const [showPromos, setShowPromos] = useState(false);
  // Mart mode: aisle filter + in-store search + on-card add (Grab Mart, not a menu)
  const [aisleId, setAisleId] = useState<string | null>(null);
  const [menuCatId, setMenuCatId] = useState<string | null>(null);
  const [storeQuery, setStoreQuery] = useState('');
  // D6-MOB-01: a supermarket/store can carry hundreds of SKUs. Mounting every
  // ProductTile (each an expo-image) at once opens slowly and risks OOM on the
  // low-end Android of the launch market. Render a bounded window and grow it as
  // the shopper nears the end. (Full unmount-on-scroll virtualization via
  // FlashList is the on-device follow-up — this bounds the eager mount now.)
  const [renderCap, setRenderCap] = useState(48);
  const cart = useCart<any>();
  const addToCart = useAddToCart();
  const updateCartItem = useUpdateCartItem();

  const v = vendor.data;
  const categories: any[] = useMemo(() => v?.categories ?? [], [v?.categories]);
  const allItems = useMemo(() => categories.flatMap((c: any) => c.items ?? []), [categories]);
  const recommended = useMemo(() => allItems.filter((i: any) => i.isPopular).slice(0, 8), [allItems]);
  const bestSellers = useMemo(
    () => [...allItems].sort((a: any, b: any) => (b.totalOrdered ?? 0) - (a.totalOrdered ?? 0)).slice(0, 8),
    [allItems],
  );
  const closed = v && !v.isCurrentlyOpen;
  const promos: any[] = v?.activePromos ?? [];
  const isMart = v?.vendorType === 'SUPERMARKET' || v?.vendorType === 'STORE';
  const isServiceStore = v?.vendorType === 'SERVICE';
  const martItems = useMemo(() => {
    const base = aisleId ? (categories.find((c: any) => c.id === aisleId)?.items ?? []) : allItems;
    const q = storeQuery.trim().toLowerCase();
    return q ? base.filter((i: any) => String(i.name).toLowerCase().includes(q)) : base;
  }, [aisleId, storeQuery, categories, allItems]);

  // Bounded render windows (see renderCap above). The mart grid is a flat slice;
  // the restaurant "full menu" caps the CUMULATIVE item count across categories
  // so a huge store never mounts everything before the shopper scrolls to it.
  const martShown = useMemo(() => martItems.slice(0, renderCap), [martItems, renderCap]);
  const cappedCategories = useMemo(() => {
    let budget = renderCap;
    const out: any[] = [];
    for (const cat of categories) {
      if (budget <= 0) break;
      const items = (cat.items ?? []).slice(0, budget);
      if (items.length > 0) {
        out.push({ ...cat, items });
        budget -= items.length;
      }
    }
    return out;
  }, [categories, renderCap]);
  const totalItems = isMart ? martItems.length : allItems.length;

  if (vendor.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
        <LoadingBlock />
      </View>
    );
  }
  if (vendor.isError || !v) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        <ErrorState onRetry={() => vendor.refetch()} />
      </View>
    );
  }

  const openItem = (item: any) => navigation.navigate('MenuItem', { vendorId, itemId: item.id });

  const cartLines: any[] = cart.data?.items ?? [];
  const cartCount = cartLines.reduce((n, l) => n + (l.quantity ?? 0), 0);
  const lineFor = (itemId: string) => cartLines.find((l) => l.itemId === itemId);
  const guardAuth = (fn: () => void) => (isAuthenticated ? fn() : promptLogin());

  const itemCard = (item: any, width: number) => (
    <FoodCard
      key={item.id}
      width={width}
      image={itemImage(item)}
      name={item.name}
      priceLabel={money(item.customerPrice ?? item.basePrice)}
      onPress={() => openItem(item)}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space['3xl'] }}
        scrollEventThrottle={64}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          if (renderCap < totalItems && contentOffset.y + layoutMeasurement.height > contentSize.height - 1000) {
            setRenderCap((c) => c + 48);
          }
        }}
      >
        {/* Cover hero + floating chips */}
        <View>
          <Image
            source={{ uri: vendorImage(v) }}
            placeholder={{ blurhash: DARK_BLURHASH }}
            transition={200}
            style={{ width: SCREEN_W, height: 300 }}
            contentFit="cover"
          />
          <View
            style={{
              position: 'absolute',
              top: insets.top + space.sm,
              left: GUTTER,
              right: GUTTER,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <CircleChip icon="chevron-left" onPress={() => navigation.goBack()} />
            <View style={{ flex: 1 }} />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <HeartBadge
                size={44}
                active={!!v.isFavorite}
                onPress={() =>
                  isAuthenticated ? toggleFav.mutate({ vendorId, isFavorite: !!v.isFavorite }) : promptLogin()
                }
              />
              <CircleChip
                icon="share-2"
                onPress={() => Share.share({ message: `${v.name} is on Swift — ${v.description ?? 'order in the app'}` })}
              />
            </View>
          </View>
        </View>

        {/* Sheet over the photo */}
        <View
          style={{
            marginTop: -radius.xl,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            backgroundColor: color.surface.subtle,
            paddingTop: space['2xl'],
          }}
        >
          <View style={{ paddingHorizontal: GUTTER, flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <T variant="title" style={{ flex: 1 }} numberOfLines={2}>
              {v.name}
            </T>
            {closed ? (
              <T variant="micro" tone="faint">
                Closed right now
              </T>
            ) : null}
          </View>

          {/* Info strip */}
          <View style={{ flexDirection: 'row', paddingHorizontal: GUTTER, marginTop: space.xl }}>
            <StatCol
              icon="star"
              value={
                v.displayRating != null
                  ? `${Number(v.displayRating).toFixed(1)} ${v.ratingBucket ?? ''}`.trim()
                  : 'New'
              }
              caption="See reviews"
              onPress={() => navigation.navigate('VendorReviews', { vendorId })}
            />
            {v.distanceKm != null ? <StatCol icon="map-pin" value={`${v.distanceKm} km`} caption="Distance" /> : null}
            {v.etaMin != null ? <StatCol icon="clock" value={`${v.etaMin} min`} caption="Arrive" /> : null}
            {/* Pickup spec 2.4 — quiet honesty: goods stores take order-ahead
                pickup; the Cart's mode toggle is where it's chosen. */}
            {!isServiceStore ? <StatCol icon="shopping-bag" value="Pickup" caption="Order ahead" /> : null}
            {hoursLabel(v.operatingHours) ? (
              <StatCol
                icon="clock"
                value={hoursLabel(v.operatingHours)!}
                caption="Hours"
                onPress={() => setShowHours(true)}
                last
              />
            ) : null}
          </View>

          {/* Live promos (real active codes) */}
          {promos.length > 0 ? (
            <Pressable onPress={() => setShowPromos(true)}>
              {({ pressed }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  paddingHorizontal: GUTTER,
                  marginTop: space.xl,
                  opacity: pressed ? 0.7 : 1,
                }}
              >
                <IconChip icon="tag" />
                <T variant="body" weight="medium" style={{ flex: 1 }}>
                  {promos.length} promo{promos.length > 1 ? 's' : ''} available
                </T>
                <Feather name="chevron-right" size={20} color={color.text.muted} />
              </View>
              )}
            </Pressable>
          ) : null}

          {closed ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                marginHorizontal: GUTTER,
                marginTop: space.xl,
                padding: space.lg,
                borderRadius: radius.md,
                backgroundColor: color.brand[50],
              }}
            >
              <Feather name="info" size={16} color={color.brand[600]} />
              <T variant="label" tone="deep" style={{ flex: 1 }}>
                Closed right now — browse the menu; ordering opens with the store.
              </T>
            </View>
          ) : null}

          {isMart ? (
            <>
              {/* In-store search + aisles + dense grid (Grab Mart) */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  marginHorizontal: GUTTER,
                  marginTop: space.xl,
                  height: 44,
                  borderRadius: 9999,
                  paddingHorizontal: space.lg,
                  backgroundColor: color.surface.base,
                  borderWidth: 1,
                  borderColor: color.border.subtle,
                }}
              >
                <Feather name="search" size={16} color={color.text.muted} />
                <TextInput
                  value={storeQuery}
                  onChangeText={setStoreQuery}
                  placeholder={`Search ${v.name}…`}
                  placeholderTextColor={color.text.muted}
                  style={{ flex: 1, fontFamily: font.body, fontSize: 14, color: color.text.primary }}
                />
                {storeQuery ? (
                  <Pressable onPress={() => setStoreQuery('')} hitSlop={8}>
                    <Feather name="x" size={16} color={color.text.muted} />
                  </Pressable>
                ) : null}
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginTop: space.lg, flexGrow: 0 }}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.md }}
              >
                <Chip label="All" selected={!aisleId} onPress={() => setAisleId(null)} style={{ height: 38, paddingHorizontal: space.lg }} />
                {categories.map((c: any) => (
                  <Chip
                    key={c.id}
                    label={c.name}
                    selected={aisleId === c.id}
                    onPress={() => setAisleId(c.id)}
                    style={{ height: 38, paddingHorizontal: space.lg }}
                  />
                ))}
              </ScrollView>
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: space.md,
                  paddingHorizontal: GUTTER,
                  paddingTop: space.lg,
                }}
              >
                {martShown.map((item: any) => (
                  <ProductTile
                    key={item.id}
                    item={item}
                    line={lineFor(item.id)}
                    busy={addToCart.isPending || updateCartItem.isPending}
                    onOpen={() => openItem(item)}
                    onAdd={() => guardAuth(() => addToCart.mutate({ vendorId, itemId: item.id, quantity: 1 }))}
                    onSetQty={(qty) => {
                      const line = lineFor(item.id);
                      if (line) updateCartItem.mutate({ id: line.id, quantity: qty });
                    }}
                  />
                ))}
              </View>
              {martItems.length === 0 ? (
                <T variant="label" tone="muted" center style={{ marginTop: space['2xl'] }}>
                  Nothing matches — try another search or aisle.
                </T>
              ) : null}
            </>
          ) : isServiceStore ? (
            <>
              {/* Bookable services: duration + where-it-happens, tap to book */}
              <SectionHeader title="Services" style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }} />
              <View style={{ paddingHorizontal: GUTTER, paddingTop: space.lg, gap: space.md }}>
                {allItems.map((item: any) => (
                  <ServiceRow key={item.id} item={item} onOpen={() => openItem(item)} />
                ))}
              </View>
            </>
          ) : (
            <>
          {/* Recommended rail */}
          {recommended.length > 0 ? (
            <>
              <SectionHeader title="Recommended for you" style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={recommended}
                keyExtractor={(i: any) => i.id}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item }) => itemCard(item, RAIL_W)}
              />
            </>
          ) : null}

          {/* Best seller rail */}
          {bestSellers.length > 0 && allItems.length > 4 ? (
            <>
              <SectionHeader title="Best seller" style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={bestSellers}
                keyExtractor={(i: any) => `bs-${i.id}`}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item }) => itemCard(item, RAIL_W)}
              />
            </>
          ) : null}

          {/* The menu — set like a real menu (design-100×): category chips filter
              (one mental model with the mart aisles), rows with name/description/
              price on one card per category. */}
          {categories.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: space['2xl'], flexGrow: 0 }}
              contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.md }}
            >
              <Chip label="Full menu" selected={!menuCatId} onPress={() => setMenuCatId(null)} style={{ height: 44, paddingHorizontal: space.lg }} />
              {categories.map((c: any) => (
                <Chip
                  key={c.id}
                  label={c.name}
                  selected={menuCatId === c.id}
                  onPress={() => setMenuCatId(c.id)}
                  style={{ height: 44, paddingHorizontal: space.lg }}
                />
              ))}
            </ScrollView>
          ) : null}
          {cappedCategories
            .filter((cat: any) => !menuCatId || cat.id === menuCatId)
            .map((cat: any) =>
              (cat.items?.length ?? 0) > 0 ? (
                <View key={cat.id}>
                  <SectionHeader title={cat.name} style={{ paddingHorizontal: GUTTER, marginTop: space['2xl'] }} />
                  <View
                    style={{
                      marginHorizontal: GUTTER,
                      marginTop: space.md,
                      paddingHorizontal: space.lg,
                      borderRadius: radius.lg,
                      backgroundColor: color.surface.base,
                      borderWidth: 1,
                      borderColor: color.border.subtle,
                    }}
                  >
                    {cat.items.map((item: any, idx: number) => {
                      const hasOptions = (item.optionGroups?.length ?? 0) > 0;
                      const line = lineFor(item.id);
                      const qty = hasOptions ? 0 : (line?.quantity ?? 0);
                      return (
                        <MenuRow
                          key={item.id}
                          name={item.name}
                          description={item.description}
                          price={item.customerPrice ?? item.basePrice}
                          image={item.imageUrl ? itemImage(item) : null}
                          soldOut={item.stockQuantity === 0}
                          qty={qty}
                          busy={addToCart.isPending || updateCartItem.isPending}
                          last={idx === cat.items.length - 1}
                          onOpen={() => openItem(item)}
                          onAdd={() =>
                            hasOptions
                              ? openItem(item)
                              : guardAuth(() => addToCart.mutate({ vendorId, itemId: item.id, quantity: 1 }))
                          }
                          onInc={() => {
                            if (line) updateCartItem.mutate({ id: line.id, quantity: (line.quantity ?? 0) + 1 });
                          }}
                          onDec={() => {
                            if (line) updateCartItem.mutate({ id: line.id, quantity: (line.quantity ?? 0) - 1 });
                          }}
                        />
                      );
                    })}
                  </View>
                </View>
              ) : null,
            )}

            </>
          )}

          {allItems.length === 0 ? (
            <T variant="label" tone="muted" center style={{ marginTop: space['3xl'] }}>
              This store hasn’t published a menu yet.
            </T>
          ) : null}
        </View>
      </ScrollView>

      {/* Mart: pinned cart bar — keep shopping, check out in one tap */}
      {isMart && cartCount > 0 ? (
        <Pressable onPress={() => navigation.navigate('Tabs', { screen: 'Cart' })}>
          {({ pressed }) => (
            <View
              style={{
                position: 'absolute',
                left: GUTTER,
                right: GUTTER,
                bottom: insets.bottom + space.lg,
                height: 52,
                borderRadius: 9999,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: space.xl,
                backgroundColor: color.brand[500],
                opacity: pressed ? 0.9 : 1,
                ...elevation.floating,
              }}
            >
              <T variant="body" weight="bold" tone="onBrand">
                View cart · {cartCount} item{cartCount === 1 ? '' : 's'}
              </T>
              <Money amount={Number(cart.data?.subtotalCustomer ?? 0)} tone="onBrand" />
            </View>
          )}
        </Pressable>
      ) : null}

      {/* Operating hours (kit 17) */}
      <PopupCard visible={showHours} onClose={() => setShowHours(false)}>
        <IconChip icon="clock" size={56} />
        <T variant="heading" style={{ marginTop: space.md }}>
          Opening hours
        </T>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg }}>
          {(v.operatingHours ?? [])
            .slice()
            .sort((a: any, b: any) => a.dayOfWeek - b.dayOfWeek)
            .map((h: any) => (
              <View
                key={h.dayOfWeek}
                style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}
              >
                <T variant="label" tone="muted">
                  {DAYS[h.dayOfWeek]}
                </T>
                <T variant="label" weight="semibold" tone={h.isClosed ? 'error' : 'ink'}>
                  {h.isClosed ? 'Closed' : `${h.openTime} – ${h.closeTime}`}
                </T>
              </View>
            ))}
        </View>
        <PillButton label="Done" size="md" onPress={() => setShowHours(false)} style={{ alignSelf: 'stretch', marginTop: space.lg }} />
      </PopupCard>

      {/* Active promos */}
      <PopupCard visible={showPromos} onClose={() => setShowPromos(false)}>
        <IconChip icon="tag" size={56} />
        <T variant="heading" style={{ marginTop: space.md }}>
          Promos
        </T>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg, gap: space.md }}>
          {promos.map((p: any) => (
            <View key={p.code} style={{ borderWidth: 1, borderColor: color.border.subtle, borderRadius: radius.md, padding: space.md }}>
              <T variant="body" weight="bold" tone="brand">
                {p.code}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {p.description}
              </T>
              {p.minOrderAmount ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }}>
                  Min order {money(p.minOrderAmount)}
                </T>
              ) : null}
            </View>
          ))}
        </View>
        <T variant="caption" tone="muted" center style={{ marginTop: space.md }}>
          Enter the code at checkout.
        </T>
        <PillButton label="Got it" size="md" onPress={() => setShowPromos(false)} style={{ alignSelf: 'stretch', marginTop: space.md }} />
      </PopupCard>
    </View>
  );
}
