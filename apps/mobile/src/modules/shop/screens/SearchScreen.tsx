/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, font, radius, space, typeScale } from '@swift/ui';
import { useHome, useSearch, useSearchSuggestions, useSearchTrending, useVendors } from '../../../hooks/customer';
import { ActionSheet } from '../../../kit/action-sheet';
import { VERTICAL_TINT } from '../../../kit/vertical-tint';
import { useAppStore } from '../../../stores/appStore';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { itemPhoto, vendorPhoto } from '../../../lib/images';
import {
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Money,
  Photo,
  RatingMeta,
  Screen,
  SectionHeader,
  T,
} from '../../../kit';

// Kit 57–60: idle = headline + history chips + popular rows.
//
// [design item 02] Results used to sit under a bare 56dp Header on paper — the
// one "head" in the customer app that did not wear the masthead — and sorting
// was a full TAB that HID the results to show four radios behind Apply/Reset.
// Sort is now a chip that opens the kit's action sheet, so the results never
// leave the screen.
//
// [100x — CHROME IS PAPER, read off the rendered design slides] The head used
// to be a full-bleed maroon `GradientMasthead` slab with a curved hem carrying
// a white search pill. There is no such slab anywhere in the customer app: the
// top of a screen is the same warm paper as the rest of it. Search is the front
// door people reach for when they already know what they want, so the FIELD is
// the focal element — a white `radius.full` pill with a hairline border sitting
// directly on paper next to a bare back chevron, exactly the shape Home now
// wears. `GradientMasthead` is NOT deleted and is still exported from the kit (FG-2), but this screen was the last caller: it now has ZERO call sites app-wide and is dead code awaiting a founder decision. Logged as an FG-2 deletion candidate — not removed here.
const GUTTER = space['2xl'];

const TYPES = [
  { key: undefined, label: 'All', tint: undefined },
  { key: 'RESTAURANT', label: 'Restaurants', tint: VERTICAL_TINT.food },
  { key: 'SUPERMARKET', label: 'Groceries', tint: VERTICAL_TINT.groceries },
  { key: 'STORE', label: 'Shops', tint: VERTICAL_TINT.shops },
  { key: 'SERVICE', label: 'Services', tint: VERTICAL_TINT.services },
] as const;

const SORTS = [
  { key: undefined, label: 'Recommended' },
  { key: 'top_rated', label: 'Top rated' },
  { key: 'popular', label: 'Popularity' },
  { key: 'distance', label: 'Distance' },
] as const;

/** The hairline that separates rows on open paper — the ONLY thing between two
 *  results now. Search results used to arrive as a stack of white cards with
 *  shadows, which drew a lit box around every merchant and made a list of
 *  places read as a list of boxes. */
function Divider() {
  return <View style={{ height: 1, backgroundColor: color.border.subtle }} />;
}

/**
 * A result on open paper — no card chassis [100x law 2].
 *
 * Same anatomy as the kit's `VendorRow` (which keeps its chassis for the
 * screens that still want one): 16:10 vendor imagery or a 1:1 product square,
 * name, meta line, the closed treatment, and a chevron unless the caller sends
 * a trailing slot. The container is simply gone — photography carries its own
 * corner radius and the text sits on the page ground.
 */
function ResultRow({
  image,
  name,
  meta,
  sub,
  trailing,
  onPress,
  wide = false,
  closed = false,
  glyph = 'shops',
}: {
  /** null ⇒ this thing genuinely has no photo; never invent one [F-264]. */
  image: string | null;
  name: string;
  meta?: React.ReactNode;
  sub?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  wide?: boolean;
  closed?: boolean;
  glyph?: React.ComponentProps<typeof Photo>['glyph'];
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={closed ? `${name}. Closed right now` : sub ? `${name}. ${sub}` : name}
    >
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            paddingVertical: space.md,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <Photo
            uri={image}
            glyph={glyph}
            style={{
              width: wide ? 96 : 84,
              height: wide ? 60 : 84,
              borderRadius: radius.md,
              opacity: closed ? 0.45 : 1,
            }}
          />
          <View style={{ flex: 1, gap: 4 }}>
            <T variant="body" weight="semibold" tone={closed ? 'muted' : 'ink'} numberOfLines={1}>
              {name}
            </T>
            {meta}
            {closed ? (
              <T variant="micro" tone="faint">
                Closed right now
              </T>
            ) : sub ? (
              <T variant="caption" tone="muted" numberOfLines={1}>
                {sub}
              </T>
            ) : null}
          </View>
          {trailing ?? <Feather name="chevron-right" size={18} color={color.text.muted} />}
        </View>
      )}
    </Pressable>
  );
}

export function SearchScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const deviceLatitude = locationFix?.latitude;
  const deviceLongitude = locationFix?.longitude;
  const { recentSearches, pushSearch, clearSearches } = useAppStore();

  const [q, setQ] = useState<string>(route.params?.q ?? '');
  const [type, setType] = useState<string | undefined>(route.params?.type);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [sortOpen, setSortOpen] = useState(false);
  const [openNow, setOpenNow] = useState(false);
  const [debounced, setDebounced] = useState(q);
  // The field is the one control on this screen, so it still has to SAY when it
  // holds the caret — the old kit input signalled focus with a brand border,
  // and maroon is now reserved (law 3). A darker hairline carries it instead.
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Commit a finished query to local history once results are being shown.
  useEffect(() => {
    if (debounced.trim().length >= 2) pushSearch(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const searching = debounced.trim().length > 0 || !!type;

  // [B2] The ENGINE takes every text query it can serve. The old path was the
  // browse endpoint's substring match — exact spelling or nothing, and a dish
  // that lives inside a menu was unfindable ("greens" ≠ "green", "pepperpot"
  // returned no store). /search brings typo tolerance, ranking, and DISHES.
  // Its schema covers the two catalogue verticals; Shops/Services text
  // queries stay on the browse path until the engine indexes them.
  const text = debounced.trim();
  const engineMode = text.length >= 2 && (!type || type === 'RESTAURANT' || type === 'SUPERMARKET');

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (debounced.trim()) p['search'] = debounced.trim();
    if (type) p['type'] = type;
    if (sort) p['sort'] = sort;
    // The browse endpoint already understands `open` — the chip is a real
    // server filter, not a client-side hide.
    if (openNow) p['open'] = 'true';
    if (deviceLatitude !== undefined && deviceLongitude !== undefined) {
      p['lat'] = String(deviceLatitude);
      p['lng'] = String(deviceLongitude);
    }
    return p;
  }, [debounced, type, sort, openNow, deviceLatitude, deviceLongitude]);

  const vendors = useVendors<any[]>(searching && !engineMode ? params : undefined);
  const engine = useSearch<any>(engineMode ? text : '', engineMode ? { type, lat: deviceLatitude, lng: deviceLongitude } : undefined);
  const suggestionsQ = useSearchSuggestions<any[]>(engineMode ? text : '');
  // Trending fuels the no-matches invitation — an empty result must open a
  // door, not dead-end. EARNED ranking (most-ordered across open stores).
  const trendingQ = useSearchTrending<any[]>(engineMode);
  const home = useHome<any>(deviceLatitude, deviceLongitude);
  const popularItems: any[] = home.data?.popularItems ?? [];

  const browseResults: any[] = Array.isArray(vendors.data) ? vendors.data : [];
  const engineVendors: any[] = engine.data?.vendors ?? [];
  // Open-now stays honest in engine mode as a filter over data we HOLD —
  // isCurrentlyOpen rides every hit — never a hidden server assumption.
  const places: any[] = engineMode
    ? (openNow ? engineVendors.filter((v) => v.isCurrentlyOpen !== false) : engineVendors)
    : browseResults;
  const dishes: any[] = engineMode ? (engine.data?.items ?? []) : [];
  const suggestions: any[] = (suggestionsQ.data ?? []).filter((s: any) => s.text?.toLowerCase() !== text.toLowerCase()).slice(0, 6);
  const resultsBusy = engineMode ? engine.isLoading : vendors.isLoading;
  const resultsError = engineMode ? engine.isError : vendors.isError;
  const retryResults = () => (engineMode ? engine.refetch() : vendors.refetch());

  const results: any[] = places;

  // Distance sorting needs coordinates: the server only re-sorts by distance
  // when lat/lng were sent (customer.routes.ts). Without a location fix it
  // silently falls back to its default order — so offering "Distance" here, and
  // then FILLING the chip as though it were applied, is the screen asserting
  // something that did not happen. Offer it only when we can actually deliver
  // it, and never claim an un-applied sort.
  const canSortByDistance = !!locationFix;
  const sortOptions = SORTS.filter((s) => s.key !== 'distance' || canSortByDistance);
  const sortApplied = !!sort && (sort !== 'distance' || canSortByDistance);
  const sortLabel = (sortApplied ? SORTS.find((s) => s.key === sort)?.label : undefined) ?? 'Recommended';

  return (
    <Screen bleed>
      {/* THE PAPER HEAD. Back chevron as a bare glyph — no filled circle, and
          `hitSlop` keeps the tap target at 44pt so the smaller mark costs
          nothing in reach. Then the field itself: white, `radius.full`, one
          hairline border, because on paper a field needs an edge to read as a
          field at all. */}
      <View
        style={{
          paddingTop: insets.top + space.sm,
          paddingBottom: space.md,
          paddingHorizontal: GUTTER,
          backgroundColor: color.surface.subtle,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="chevron-left" size={24} color={color.text.primary} />
          </Pressable>
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              // minHeight, not a fixed 48 — the pill has to GROW with Dynamic
              // Type rather than clip the caret at large font scales.
              minHeight: 48,
              paddingHorizontal: space.lg,
              borderRadius: radius.full,
              backgroundColor: color.surface.base,
              borderWidth: 1,
              borderColor: focused ? color.border.strong : color.border.subtle,
            }}
          >
            <Feather name="search" size={17} color={focused ? color.text.primary : color.text.muted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Restaurants, groceries, dishes…"
              placeholderTextColor={color.text.muted}
              returnKeyType="search"
              autoFocus={!!route.params?.focus}
              accessibilityLabel="Search"
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                flex: 1,
                fontFamily: font.body,
                fontSize: typeScale.body.fontSize,
                color: color.text.primary,
                paddingVertical: space.md,
              }}
            />
          </View>
        </View>
      </View>

      <View style={{ paddingTop: space.md }}>
        {!searching ? (
          <T variant="title" style={{ paddingHorizontal: GUTTER, marginBottom: space.xl }}>
            What are you{'\n'}looking for?
          </T>
        ) : null}
        {/* Vendor-type filter chips (the Home tiles preset these). MAROON IS
            RESERVED (law 3): a selected chip is one of the four things allowed
            to wear it, so selection is a maroon fill and everything else is
            white with a hairline. The per-vertical tints stay declared on TYPES
            — nothing is deleted — but the chips no longer paint with them, so
            the row reads as one filter control instead of five liveries. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // A horizontal row must HUG its chips: in this flex column an
          // un-heighted ScrollView grows to swallow the leftover screen and
          // the results get shoved to the bottom (founder screenshot, 08-30).
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: space.md, paddingHorizontal: GUTTER }}
        >
          {TYPES.map((t) => (
            <Chip
              key={t.label}
              label={t.label}
              selected={type === t.key}
              onPress={() => setType(t.key)}
              style={{ height: 44, paddingHorizontal: space.lg }}
            />
          ))}
        </ScrollView>
      </View>

      {searching ? (
        <>
          {/* Sort and availability ride ABOVE the results as chips — the old
              "Sort by" tab hid every result to show four radio buttons behind
              Apply/Reset, which is a modal dialog wearing a tab's clothes. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: space.md, flexGrow: 0 }}
            contentContainerStyle={{ gap: space.md, paddingHorizontal: GUTTER }}
          >
            {/* [B2] In engine mode the ranking IS the sort (words · typo ·
                proximity · exactness) — offering a sort chip that silently
                no-ops would be the screen asserting an order it didn't apply.
                Browse mode keeps its real server sorts. */}
            {engineMode ? null : (
            <Pressable
              testID="search-sort-chip"
              onPress={() => setSortOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Sort: ${sortLabel}. Change sort order`}
            >
              {({ pressed }) => (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.sm,
                    height: 44,
                    paddingHorizontal: space.lg,
                    borderRadius: radius.full,
                    borderWidth: 1,
                    // A non-default sort IS a selected chip, so it fills like
                    // one instead of merely outlining itself in brand.
                    borderColor: sortApplied ? color.brand[500] : color.border.subtle,
                    backgroundColor: sortApplied ? color.brand[500] : color.surface.base,
                    opacity: pressed ? 0.75 : 1,
                  }}
                >
                  <T variant="label" weight={sortApplied ? 'semibold' : 'medium'} tone={sortApplied ? 'onBrand' : 'ink'}>
                    Sort · {sortLabel}
                  </T>
                  <Feather name="chevron-down" size={15} color={sortApplied ? color.white : color.text.muted} />
                </View>
              )}
            </Pressable>
            )}
            <Chip
              label="Open now"
              selected={openNow}
              onPress={() => setOpenNow((v) => !v)}
              style={{ height: 44, paddingHorizontal: space.lg }}
            />
          </ScrollView>

          {/* [B2] Autocomplete from the engine — tappable words, not a
              dropdown: “did you mean” as chips while you type. */}
          {engineMode && suggestions.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: space.md, flexGrow: 0 }}
              contentContainerStyle={{ gap: space.sm, paddingHorizontal: GUTTER }}
            >
              {suggestions.map((s: any) => (
                <Chip key={`${s.type}-${s.text}`} label={s.text} onPress={() => setQ(s.text)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </ScrollView>
          ) : null}

          {(
            resultsBusy ? (
              <LoadingBlock />
            ) : resultsError ? (
              <ErrorState onRetry={() => void retryResults()} />
            ) : results.length === 0 && dishes.length === 0 ? (
              <ScrollView contentContainerStyle={{ paddingBottom: space['3xl'] }}>
                <EmptyState
                  icon="search"
                  title="No matches"
                  body={
                    debounced.trim()
                      ? `Nothing matched “${debounced.trim()}”. Try fewer words, or browse ${(TYPES.find((t) => t.key === type)?.label ?? 'everything').toLowerCase()}.`
                      : 'Nothing here right now — check back soon.'
                  }
                />
                {/* [B2] The invitation half of the empty state: what people
                    ARE ordering right now — earned ranking, open stores only. */}
                {engineMode && (trendingQ.data?.length ?? 0) > 0 ? (
                  <View style={{ paddingHorizontal: GUTTER }}>
                    <SectionHeader title="Worth trying right now" />
                    <View style={{ marginTop: space.sm }}>
                      {(trendingQ.data ?? []).slice(0, 6).map((it: any, i: number) => (
                        <React.Fragment key={it.id}>
                          {i > 0 ? <Divider /> : null}
                          <ResultRow
                            image={itemPhoto(it)}
                            glyph="food"
                            name={it.name}
                            sub={it.vendorName}
                            trailing={<Money amount={it.basePrice} />}
                            onPress={() => navigation.navigate('MenuItem', { itemId: it.id, vendorId: it.vendorId })}
                          />
                        </React.Fragment>
                      ))}
                    </View>
                  </View>
                ) : null}
              </ScrollView>
            ) : engineMode ? (
              // [B2] Engine results: PLACES then DISHES — the second section is
              // the whole point ("pepperpot" now finds the dish, not silence).
              <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: space.lg, paddingBottom: space['3xl'] }}>
                {results.length > 0 ? (
                  <>
                    {/* [Wave 3 vs reference 10] The header says HOW the list is
                        ordered, not just how long it is. In engine mode the
                        ranking is the engine's — relevance — and saying so is
                        the honest version of the reference's "sorted by". */}
                    <T variant="caption" tone="muted" style={{ marginBottom: space.sm }}>
                      {results.length} {results.length === 1 ? 'place' : 'places'} · sorted by relevance
                    </T>
                    {results.map((v: any, i: number) => (
                      <React.Fragment key={v.id}>
                        {i > 0 ? <Divider /> : null}
                        <ResultRow
                          image={vendorPhoto(v)}
                          name={v.name}
                          meta={<RatingMeta rating={v.displayRating ?? null} topRated={v.topRated} />}
                          wide
                          closed={v.isCurrentlyOpen === false}
                          onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                        />
                      </React.Fragment>
                    ))}
                  </>
                ) : null}
                {dishes.length > 0 ? (
                  <>
                    <SectionHeader title="Dishes" style={{ marginTop: results.length ? space['2xl'] : 0 }} />
                    <View style={{ marginTop: space.sm }}>
                      {dishes.map((it: any, i: number) => (
                        <React.Fragment key={it.id}>
                          {i > 0 ? <Divider /> : null}
                          <ResultRow
                            image={itemPhoto(it)}
                            glyph="food"
                            name={it.name}
                            sub={it.categoryName ? `${it.vendorName} · ${it.categoryName}` : it.vendorName}
                            trailing={<Money amount={it.basePrice} />}
                            onPress={() => navigation.navigate('MenuItem', { itemId: it.id, vendorId: it.vendorId })}
                          />
                        </React.Fragment>
                      ))}
                    </View>
                  </>
                ) : null}
              </ScrollView>
            ) : (
              <FlatList
                data={results}
                keyExtractor={(v) => v.id}
                contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: space.lg, paddingBottom: space['3xl'] }}
                ItemSeparatorComponent={Divider}
                ListHeaderComponent={
                  // [Wave 3 vs reference 10] "4 places · sorted by recommended"
                  // — the applied server sort, named; never a claim about an
                  // order that wasn't applied (the distance rule above).
                  <T variant="caption" tone="muted" style={{ marginBottom: space.sm }}>
                    {results.length} {results.length === 1 ? 'place' : 'places'} · sorted by {sortLabel.toLowerCase()}
                  </T>
                }
                renderItem={({ item: v }) => (
                  <ResultRow
                    image={vendorPhoto(v)}
                    name={v.name}
                    meta={
                      <RatingMeta
                        rating={v.displayRating ?? null}
                        bucket={v.ratingBucket}
                        topRated={v.topRated}
                        extra={v.etaMin
                          ? `${v.etaMin} min`
                          : locationFix && v.distanceKm != null
                            ? `${v.distanceKm} km`
                            : undefined}
                      />
                    }
                    wide
                    closed={v.isCurrentlyOpen === false}
                    onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
                  />
                )}
              />
            )
          )}

          {/* Selecting IS applying — there is nothing to confirm about a sort
              order, so Apply/Reset are gone. */}
          <ActionSheet
            open={sortOpen}
            onClose={() => setSortOpen(false)}
            title="Sort by"
            actions={sortOptions.map((s) => ({
              label: s.key === sort ? `${s.label}  ✓` : s.label,
              onPress: () => {
                setSort(s.key);
                setSortOpen(false);
              },
            }))}
          />
        </>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: space['2xl'], paddingBottom: space['3xl'] }}>
          {recentSearches.length > 0 ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <SectionHeader title="Your search history" />
                <Pressable onPress={clearSearches} hitSlop={8}>
                  <View style={{ paddingVertical: 4 }}>
                    <T variant="label" tone="faint">
                      Clear
                    </T>
                  </View>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg }}>
                {recentSearches.map((r) => (
                  <Chip key={r} label={r} onPress={() => setQ(r)} style={{ height: 44 }} />
                ))}
              </View>
            </>
          ) : null}

          {popularItems.length > 0 ? (
            <>
              <SectionHeader title="Popular right now" style={{ marginTop: recentSearches.length ? space['3xl'] : 0 }} />
              {/* MONEY IS INK, never brand (law 3): these prices were brand-red,
                  which is the same red as the one CTA on every other screen —
                  red stops meaning "act" when it also means "$2,500". */}
              <View style={{ marginTop: space.sm }}>
                {popularItems.slice(0, 6).map((it, i) => (
                  <React.Fragment key={it.id}>
                    {i > 0 ? <Divider /> : null}
                    <ResultRow
                      image={itemPhoto(it)}
                      glyph="food"
                      name={it.name}
                      sub={it.vendorName}
                      trailing={<Money amount={it.price} />}
                      onPress={() => navigation.navigate('MenuItem', { itemId: it.id, vendorId: it.vendorId })}
                    />
                  </React.Fragment>
                ))}
              </View>
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
