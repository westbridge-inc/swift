/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Dimensions, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useDiscoveryCategories, useMarketItems, useAddToCart, type MarketItem } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { haptic } from '../../../lib/haptics';
import { toast } from '../../../kit/toast';
import { EmptyState, ErrorState, LoadingBlock, Money, PhotoPlaceholder, T } from '../../../kit';

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
 * DELIBERATELY NOT HERE, because each needs a founder decision and inventing
 * one would be worse than its absence:
 *   · the `NEW THIS WEEK / Made in Guyana` hero (M-D4 — unbuilt campaign slot)
 *   · per-item star ratings (M-D2 — `Item` has no rating; only the VENDOR has
 *     one, and showing a seller's stars on a product is a different claim)
 *   · `LIMITED` / `HANDMADE` badges (M-D3 — not derivable from any field)
 * The old `Open now` lens is gone with the vendor list: it filtered VENDORS,
 * the feed returns ITEMS, and a chip that filters nothing is a chip that lies.
 */
const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const CARD_W = Math.floor((SCREEN_W - GUTTER * 2 - space.lg) / 2);

export function MarketScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const [category, setCategory] = useState<string | undefined>(undefined);

  const rail = useDiscoveryCategories(locationFix?.latitude, locationFix?.longitude);
  const feed = useMarketItems({ category, sort: 'popular' });
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
        <T variant="micro" tone="muted">
          SWIFT MARKET · GEORGETOWN
        </T>
        <T variant="title" style={{ marginTop: space.xs }}>
          Market
        </T>

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
            {[{ slug: undefined as string | undefined, name: 'All' }, ...chips].map((c) => {
              const selected = category === c.slug;
              return (
                <Pressable
                  key={c.slug ?? 'all'}
                  onPress={() => setCategory(c.slug)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  {({ pressed }) => (
                    <View
                      style={{
                        height: 36,
                        paddingHorizontal: space.lg,
                        borderRadius: radius.full,
                        borderWidth: 1,
                        alignItems: 'center',
                        justifyContent: 'center',
                        // Maroon fill on the SELECTED chip only — one of the few
                        // places the brand is allowed to appear [100x law 3].
                        borderColor: selected ? color.brand[500] : color.border.subtle,
                        backgroundColor: selected ? color.brand[500] : color.surface.base,
                        opacity: pressed ? 0.85 : 1,
                      }}
                    >
                      <T variant="label" weight={selected ? 'semibold' : 'medium'} tone={selected ? 'onBrand' : 'ink'}>
                        {c.name}
                      </T>
                    </View>
                  )}
                </Pressable>
              );
            })}
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
          contentContainerStyle={{ gap: space.xl, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
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
              accessibilityLabel={`${item.name}. ${item.vendorName}.`}
              style={{ width: CARD_W }}
            >
              {({ pressed }) => (
                <View style={{ opacity: pressed ? 0.85 : 1 }}>
                  <View style={{ width: '100%', aspectRatio: 1, borderRadius: radius.lg, overflow: 'hidden' }}>
                    {/* Never a stranger's photograph in place of a missing one —
                        the honest placeholder carries the item's own name. */}
                    <PhotoPlaceholder label={item.name} glyph="shops" style={{ width: '100%', height: '100%' }} />
                  </View>

                  <T variant="label" weight="semibold" numberOfLines={2} style={{ marginTop: space.sm }}>
                    {item.name}
                  </T>
                  {/* THE STORE, on every card. "It'll be at their respective
                      stores" is the whole point of a product-first market: you
                      browse by thing and arrive at a shop. */}
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {item.vendorName}
                  </T>

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                    <Money amount={item.basePrice} />
                    <Pressable
                      onPress={() => onAdd(item)}
                      disabled={addToCart.isPending}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${item.name} to cart`}
                      hitSlop={8}
                    >
                      {({ pressed: p2 }) => (
                        <View
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: radius.full,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: color.brand[500],
                            opacity: p2 || addToCart.isPending ? 0.7 : 1,
                          }}
                        >
                          <Feather name="plus" size={17} color={color.white} />
                        </View>
                      )}
                    </Pressable>
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
