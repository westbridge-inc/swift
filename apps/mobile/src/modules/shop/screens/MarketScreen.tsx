/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Dimensions, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useVendors } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { vendorPhoto } from '../../../lib/images';
import { EmptyState, ErrorState, LoadingBlock, Photo, RatingMeta, T } from '../../../kit';

/**
 * THE MARKET TAB [100x pass §4a · MKT-2].
 *
 * Goods, not food. Clothes, tools, household things — the stuff a STORE sells.
 * The founder's framing: Home keeps Food, Groceries, Taxi, Send, Orders and
 * Services; "Shops" LEAVES Home because it stops being a tile and becomes this.
 *
 * MARKETPLACE IS A LENS, NEVER A FORK [MKT-1 law]. There is no market catalog,
 * no market cart and no market search index. This reads the SAME vendors API
 * every other surface reads, filtered to `type=STORE`, and pressing a store
 * opens the SAME store screen. One catalog, one cart, one design system.
 *
 * That is also why this shipped without a dedicated `/v1/market/items` feed: the
 * endpoint the design imagines does not exist yet, and inventing a second
 * catalog to fill a tab would be exactly the fork the law forbids. When the feed
 * lands (goods categories, variants, a hero campaign) it slots in here — the tab
 * does not need to be rebuilt around it.
 *
 * B2C only, per the founder: verified weekly-fee vendors sell. There is no
 * listing path for individuals anywhere in this screen, deliberately.
 */
const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const CARD_W = Math.floor((SCREEN_W - GUTTER * 2 - space.lg) / 2);

/** The goods lenses the design names. Each is a real server filter, never a
 *  client-side hide — a chip that filters nothing is a chip that lies. */
const LENSES = [
  { key: undefined, label: 'All' },
  { key: 'open', label: 'Open now' },
] as const;

export function MarketScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const [lens, setLens] = useState<string | undefined>(undefined);

  const params = useMemo(() => {
    const p: Record<string, string> = { type: 'STORE' };
    if (lens === 'open') p['open'] = 'true';
    if (locationFix) {
      p['lat'] = String(locationFix.latitude);
      p['lng'] = String(locationFix.longitude);
    }
    return p;
  }, [lens, locationFix]);

  const stores = useVendors<any[]>(params);
  const rows: any[] = Array.isArray(stores.data) ? stores.data : [];

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

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.sm, paddingTop: space.md, paddingRight: GUTTER }}
        >
          {LENSES.map((l) => {
            const selected = lens === l.key;
            return (
              <Pressable key={l.label} onPress={() => setLens(l.key)} accessibilityRole="button">
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
                      {l.label}
                    </T>
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {stores.isLoading && rows.length === 0 ? (
        <LoadingBlock />
      ) : stores.isError && rows.length === 0 ? (
        <ErrorState
          message="We couldn't load the market. Check your connection and try again."
          onRetry={() => stores.refetch()}
        />
      ) : rows.length === 0 ? (
        // An honest empty: it says which lens is filtering, so "nothing here"
        // never reads as "Swift has no shops".
        <EmptyState
          title={lens === 'open' ? 'No shops open right now' : 'No shops yet'}
          body={
            lens === 'open'
              ? 'Nothing is taking orders this minute. Switch to All to see every shop.'
              : 'Shops selling clothes, tools and household goods will appear here.'
          }
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(v: any) => String(v.id)}
          numColumns={2}
          columnWrapperStyle={{ gap: space.lg, paddingHorizontal: GUTTER }}
          contentContainerStyle={{ gap: space.xl, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={stores.isRefetching}
              onRefresh={() => stores.refetch()}
              tintColor={color.brand[500]}
            />
          }
          renderItem={({ item: v }) => {
            // Goods sell on photography, so the photo leads — on open paper,
            // with no card chassis around it [100x law 2].
            const closed = v.isCurrentlyOpen === false;
            return (
              <Pressable
                onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                accessibilityRole="button"
                accessibilityLabel={closed ? `${v.name}. Closed right now` : v.name}
                style={{ width: CARD_W }}
              >
                {({ pressed }) => (
                  <View style={{ opacity: pressed ? 0.85 : 1 }}>
                    <Photo
                      uri={vendorPhoto(v)}
                      glyph="shops"
                      label={v.name}
                      style={{ width: '100%', aspectRatio: 1, borderRadius: radius.lg, opacity: closed ? 0.45 : 1 }}
                    />
                    <T
                      variant="label"
                      weight="semibold"
                      tone={closed ? 'muted' : 'ink'}
                      numberOfLines={1}
                      style={{ marginTop: space.sm }}
                    >
                      {v.name}
                    </T>
                    {closed ? (
                      <T variant="micro" tone="faint" style={{ marginTop: 2 }}>
                        Closed right now
                      </T>
                    ) : (
                      // Only what the server actually sent — never an invented
                      // rating and never a placeholder distance.
                      //
                      // [ALG-31 / L2] `displayRating`, NOT `averageRating`. The
                      // raw lifetime mean was rendered here, so City Hardware —
                      // ONE rating, of 1 — showed ★1.0 on the front page of the
                      // Market tab. `rating-surface.ts` is the one mapper and it
                      // returns null below RATING_MIN_DISPLAY (5), which is what
                      // makes that card read "New" instead. It is also the
                      // protection new vendors depend on: a single bad rating
                      // must never brand a shop before it has a record.
                      <View style={{ marginTop: 2 }}>
                        <RatingMeta
                          rating={v.displayRating ?? null}
                          extra={v.distanceKm != null ? `${v.distanceKm} km` : undefined}
                        />
                      </View>
                    )}
                  </View>
                )}
              </Pressable>
            );
          }}
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
