/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Dimensions, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, elevation, radius, space } from '@swift/ui';
import { useDiscoveryCategories, useMarketItems, useAddToCart, type MarketItem } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { itemPhoto } from '../../../lib/images';
import { haptic } from '../../../lib/haptics';
import { toast } from '../../../kit/toast';
import {
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Money,
  Photo,
  SectionHeader,
  T,
  TonePill,
} from '../../../kit';
import { VERTICAL_TINT } from '../../../kit/vertical-tint';

/**
 * THE MARKET TAB — A CATALOGUE, NOT A DIRECTORY [MKT G2].
 *
 * This screen used to call `useVendors({ type: 'STORE' })` and render shop
 * cards: pressing one opened a store, and no item ever appeared on it. The ask
 * was the opposite — "all items listed by categories… tools, hardware, clothes,
 * jewellery… and when they click the item it'll be at their respective store,
 * like Amazon". One lists SHOPS; the other lists THINGS.
 *
 * REPLACED IN PLACE: same path, same export, same route. No `V2`, no flag, no
 * parallel screen — the one-way door.
 *
 * MARKETPLACE IS A LENS, NEVER A FORK [MKT-1]. There is still no market
 * catalogue, no market cart and no market search index. This reads
 * `GET /market/items`, which returns the SAME `ItemHit` shape search returns,
 * and adds to the SAME cart every other surface uses.
 *
 * B2C only, per the founder: verified weekly-fee vendors sell. There is no
 * listing path for individuals anywhere in this screen, deliberately.
 *
 * ── ASSEMBLED FROM THE KIT, NOT INVENTED [WS-3.1 rule 2] ────────────────────
 * The first cut of this screen hand-drew three shapes the kit already owned:
 * the category pill (`Chip`), the section header (`SectionHeader`) and the
 * status badge (`TonePill`). Re-expressing a primitive is how a design system
 * dies one screen at a time — and the hand-drawn chip was 36pt tall, under the
 * 44pt touch minimum the kit's `Chip` has always met. Every shape here now
 * comes from the kit; if this screen ever needs one the kit lacks, the kit
 * gains it first.
 *
 * ── WHAT THE REFERENCE DRAWS THAT IS DELIBERATELY ABSENT ────────────────────
 * `04-customer-market.png` is the founder's binding spec, and three things on
 * it cannot be built honestly today. Each is registered, not quietly dropped:
 *
 *   · THE HERO (`NEW THIS WEEK / Made in Guyana / Shop now`) — M-D4. There is
 *     no editorial campaign model. The Ads platform exists, but an ad in an
 *     editorial slot is a different product and the founder's call to make.
 *   · `LIMITED` / `HANDMADE` badges — M-D3. No field on `Item` produces them.
 *     `NEW` is the one badge with a real source, and it ships below.
 *   · THE HEART — M-D7, NEW, and the marketplace document is wrong about this
 *     one. It says "the heart on the product card is `useToggleFavorite`,
 *     neither is new work". `useToggleFavorite` takes a `vendorId`: the schema
 *     has `Customer.favoriteVendors`, a store bookmark, and NO item favourite
 *     anywhere. So the heart on a PRODUCT would either need a new relation —
 *     which changes what the existing Favourites screen means — or it would
 *     favourite the shop while sitting on the item, which is the UI lying about
 *     what the tap did. Wishlists are a founder decision, so it waits for one.
 *
 * Item star ratings are absent for the same reason (M-D2): `Item` has no rating
 * and the VENDOR's stars on a product make a claim about the wrong thing.
 */
const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const CARD_W = Math.floor((SCREEN_W - GUTTER * 2 - space.lg) / 2);

/** The Market's own identity colour — plum, the `shops` entry in the vertical
 *  ramp. An un-photographed item gets ITS vertical's ground, not the house
 *  maroon, so a market card reads as market at a glance. */
const MARKET_TINT = VERTICAL_TINT.shops;

export function MarketScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const [category, setCategory] = useState<string | undefined>(undefined);

  const rail = useDiscoveryCategories(locationFix?.latitude, locationFix?.longitude);
  const feed = useMarketItems({ category });
  const addToCart = useAddToCart();

  // RETAIL only: this tab is goods. A food category chip here would filter the
  // feed to nothing and read as "we have no tools".
  const chips = useMemo(
    () => (rail.data?.categories ?? []).filter((c) => c.vertical === 'RETAIL'),
    [rail.data],
  );

  const items: MarketItem[] = useMemo(
    () => ((feed.data?.pages as { items: MarketItem[] }[] | undefined) ?? []).flatMap((p) => p.items),
    [feed.data],
  );

  const activeChip = chips.find((c) => c.slug === category);

  const onAdd = (item: MarketItem) => {
    haptic.select();
    addToCart.mutate(
      { vendorId: item.vendorId, itemId: item.id, quantity: 1 },
      {
        onSuccess: () => toast.success(`${item.name} added`),
        // The cart refuses a second vendor mid-order; that refusal is the
        // server's to explain, so its words are shown rather than replaced.
        onError: (e: any) =>
          toast.error(e?.response?.data?.error?.message ?? 'Couldn’t add that — try again.'),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      {/* Paper chrome, same as every other customer screen — no maroon slab. */}
      <View style={{ paddingTop: insets.top, paddingHorizontal: GUTTER, paddingBottom: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <T variant="micro" tone="muted">
              SWIFT MARKET · GEORGETOWN
            </T>
            <T variant="title" style={{ marginTop: space.xs }}>
              Market
            </T>
          </View>
          {/* The reference's two circular buttons. Search is the front door to
              the same engine the Search tab uses — never a second index. */}
          <View style={{ flexDirection: 'row', gap: space.sm, paddingTop: space.xs }}>
            <CircleButton
              icon="search"
              label="Search the market"
              onPress={() => navigation.navigate('Search')}
            />
            <CircleButton
              icon="bell"
              label="Notifications"
              onPress={() => navigation.navigate('Notifications')}
            />
          </View>
        </View>

        {/* Every chip is a REAL server filter on the feed — never a client-side
            hide. The rail is server-flagged and returns only categories that
            actually have stock behind them, so an empty rail means there is
            nothing to browse yet, not that the chips broke. */}
        {chips.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.sm, paddingTop: space.md, paddingRight: GUTTER }}
          >
            {[{ slug: undefined as string | undefined, name: 'All' }, ...chips].map((c) => (
              <Chip
                key={c.slug ?? 'all'}
                label={c.name}
                selected={category === c.slug}
                onPress={() => setCategory(c.slug)}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {feed.isLoading && items.length === 0 ? (
        <LoadingBlock />
      ) : feed.isError && items.length === 0 ? (
        <ErrorState
          message="We couldn't load the market. Check your connection and try again."
          onRetry={() => feed.refetch()}
        />
      ) : items.length === 0 ? (
        // An honest empty: it names the filter, so "nothing here" never reads
        // as "Swift sells nothing". Below the launch-depth threshold the TAB
        // itself should not be showing (G7) — that gate is a separate change.
        <EmptyState
          title={category ? 'Nothing in this category yet' : 'The market is still filling up'}
          body={
            category
              ? 'No store has listed anything here yet. Try another category.'
              : 'Local sellers are still adding their goods. Check back soon.'
          }
          {...(category ? { actionLabel: 'See everything', onAction: () => setCategory(undefined) } : {})}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          numColumns={2}
          columnWrapperStyle={{ gap: space.lg, paddingHorizontal: GUTTER }}
          contentContainerStyle={{ gap: space.lg, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            // The eyebrow states something TRUE about the section — the kit's
            // own rule for this component. These ARE local sellers, and the
            // feed IS newest-first, so both halves of the sentence hold. When a
            // category is on, the title names the category rather than
            // repeating "New arrivals" over a filtered shelf; `See all` is the
            // way back out, and it is absent when there is nothing to go back
            // to (a `See all` that only ever reloaded the same grid would be
            // decoration pretending to be an action).
            <View style={{ paddingHorizontal: GUTTER, paddingBottom: space.md }}>
              <SectionHeader
                eyebrow="Fresh from local sellers"
                title={activeChip?.name ?? 'New arrivals'}
                size="lg"
                {...(category ? { onSeeAll: () => setCategory(undefined) } : {})}
              />
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={feed.isRefetching && !feed.isFetchingNextPage}
              onRefresh={() => feed.refetch()}
              tintColor={color.brand[500]}
            />
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
          }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => navigation.navigate('MenuItem', { itemId: item.id, vendorId: item.vendorId })}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}. ${item.vendorName}.${item.isNew ? ' New.' : ''}`}
              style={{ width: CARD_W }}
            >
              {({ pressed }) => (
                <View
                  style={[
                    {
                      backgroundColor: color.surface.base,
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderColor: color.border.subtle,
                      overflow: 'hidden',
                      opacity: pressed ? 0.9 : 1,
                    },
                    elevation.card,
                  ]}
                >
                  <View style={{ width: '100%', aspectRatio: 1 }}>
                    {/* The merchant's REAL photograph when they have uploaded
                        one — the first cut of this card drew the placeholder
                        unconditionally and threw `imageUrl` away, so a vendor
                        who had photographed their stock saw a pictogram anyway.
                        `Photo` falls back to the honest placeholder (the
                        vertical's ground + the item's own name) and never to a
                        stranger's photograph. */}
                    <Photo
                      uri={itemPhoto(item)}
                      label={item.name}
                      glyph="shops"
                      {...(MARKET_TINT ? { tint: MARKET_TINT } : {})}
                      style={{ width: '100%', height: '100%' }}
                    />
                    {item.isNew ? (
                      <View style={{ position: 'absolute', top: space.sm, left: space.sm }}>
                        {/* The ONE badge with a real source behind it. */}
                        <TonePill label="NEW" tone="neutral" dark />
                      </View>
                    ) : null}
                  </View>

                  <View style={{ padding: space.md, gap: 2 }}>
                    <T variant="label" weight="semibold" numberOfLines={2}>
                      {item.name}
                    </T>
                    {/* THE STORE, on every card. "It'll be at their respective
                        stores" is the whole point of a product-first market: you
                        browse by thing and arrive at a shop. */}
                    <T variant="caption" tone="muted" numberOfLines={1}>
                      {item.vendorName}
                    </T>

                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginTop: space.xs,
                      }}
                    >
                      {/* Maroon on the price is the founder's reference, and it
                          takes this screen to three brand elements against the
                          "maroon ≤2 per screen" law — chip, price, add button.
                          REGISTERED, not silently resolved: the screenshot is
                          the binding spec for this tab [WS-3.6]. */}
                      <Money amount={item.basePrice} tone="brand" />
                      <Pressable
                        onPress={() => onAdd(item)}
                        disabled={addToCart.isPending}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${item.name} to cart`}
                        hitSlop={10}
                      >
                        {({ pressed: p2 }) => (
                          <View
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: radius.full,
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: color.brand[500],
                              opacity: p2 || addToCart.isPending ? 0.7 : 1,
                            }}
                          >
                            <Feather name="plus" size={18} color={color.white} />
                          </View>
                        )}
                      </Pressable>
                    </View>
                  </View>
                </View>
              )}
            </Pressable>
          )}
          ListFooterComponent={
            <View style={{ paddingHorizontal: GUTTER, paddingTop: space.xl, flexDirection: 'row', gap: space.sm }}>
              <Feather name="check-circle" size={16} color={color.success} style={{ marginTop: 2 }} />
              <T variant="caption" tone="muted" style={{ flex: 1 }}>
                Every shop here pays Swift a flat weekly fee and keeps 100% of what it sells.
              </T>
            </View>
          }
        />
      )}
    </View>
  );
}

/** The masthead's circular icon button. 44pt, because an icon-only control at
 *  the top of a tab is exactly where the touch minimum gets quietly missed. */
function CircleButton({
  icon,
  label,
  onPress,
}: {
  icon: 'search' | 'bell';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {({ pressed }) => (
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.surface.base,
            borderWidth: 1,
            borderColor: color.border.subtle,
            opacity: pressed ? 0.8 : 1,
          }}
        >
          <Feather name={icon} size={19} color={color.text.primary} />
        </View>
      )}
    </Pressable>
  );
}
