/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useHome, useVendors } from '../../../hooks/customer';
import { useAppStore } from '../../../stores/appStore';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { itemImage, vendorImage } from '../../../lib/images';
import {
  Chip,
  EmptyState,
  ErrorState,
  Header,
  LabeledInput,
  LoadingBlock,
  Money,
  PillButton,
  RatingMeta,
  Screen,
  SectionHeader,
  T,
  VendorRow,
} from '../../../kit';

// Kit 57–60: idle = headline + history chips + popular rows; typing/results =
// underline tabs Result | Sort By; sort = radio list + Apply/Reset.
const TYPES = [
  { key: undefined, label: 'All' },
  { key: 'RESTAURANT', label: 'Restaurants' },
  { key: 'SUPERMARKET', label: 'Groceries' },
  { key: 'STORE', label: 'Shops' },
  { key: 'SERVICE', label: 'Services' },
] as const;

const SORTS = [
  { key: undefined, label: 'Recommended' },
  { key: 'top_rated', label: 'Top rated' },
  { key: 'popular', label: 'Popularity' },
  { key: 'distance', label: 'Distance' },
] as const;

function Radio({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: on ? 6 : 1.5,
        borderColor: on ? color.brand[500] : color.border.strong,
        backgroundColor: color.surface.base,
      }}
    />
  );
}

export function SearchScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const deviceLatitude = locationFix?.latitude;
  const deviceLongitude = locationFix?.longitude;
  const { recentSearches, pushSearch, clearSearches } = useAppStore();

  const [q, setQ] = useState<string>(route.params?.q ?? '');
  const [type, setType] = useState<string | undefined>(route.params?.type);
  const [tab, setTab] = useState<'result' | 'sort'>('result');
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [draftSort, setDraftSort] = useState<string | undefined>(undefined);
  const [debounced, setDebounced] = useState(q);

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

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (debounced.trim()) p['search'] = debounced.trim();
    if (type) p['type'] = type;
    if (sort) p['sort'] = sort;
    if (deviceLatitude !== undefined && deviceLongitude !== undefined) {
      p['lat'] = String(deviceLatitude);
      p['lng'] = String(deviceLongitude);
    }
    return p;
  }, [debounced, type, sort, deviceLatitude, deviceLongitude]);

  const vendors = useVendors<any[]>(searching ? params : undefined);
  const home = useHome<any>(deviceLatitude, deviceLongitude);
  const popularItems: any[] = home.data?.popularItems ?? [];

  const results: any[] = Array.isArray(vendors.data) ? vendors.data : [];

  return (
    <Screen>
      <Header title="Search" />
      <View style={{ paddingHorizontal: space['2xl'], paddingTop: space.sm }}>
        {!searching ? (
          <T variant="title" style={{ marginBottom: space.xl }}>
            What are you{'\n'}looking for?
          </T>
        ) : null}
        <LabeledInput
          icon="search"
          placeholder="Restaurants, groceries, dishes…"
          value={q}
          onChangeText={setQ}
          returnKeyType="search"
          autoFocus={!!route.params?.focus}
        />
        {/* Vendor-type filter chips (the Home tiles preset these) */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.lg }} contentContainerStyle={{ gap: space.md }}>
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
          {/* Kit underline tabs: Result | Sort By */}
          <View style={{ flexDirection: 'row', marginTop: space.xl }}>
            {(
              [
                { key: 'result', label: 'Result' },
                { key: 'sort', label: 'Sort by' },
              ] as const
            ).map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={{ flex: 1 }}>
                <View style={{ alignItems: 'center' }}>
                  <T variant="body" weight="semibold" tone={tab === t.key ? 'ink' : 'faint'}>
                    {t.label}
                  </T>
                  <View
                    style={{
                      height: 3,
                      alignSelf: 'stretch',
                      marginTop: space.md,
                      borderRadius: 2,
                      backgroundColor: tab === t.key ? color.brand[500] : color.border.subtle,
                    }}
                  />
                </View>
              </Pressable>
            ))}
          </View>

          {tab === 'result' ? (
            vendors.isLoading ? (
              <LoadingBlock />
            ) : vendors.isError ? (
              <ErrorState onRetry={() => vendors.refetch()} />
            ) : results.length === 0 ? (
              <EmptyState
                icon="search"
                title="No matches"
                body={
                  debounced.trim()
                    ? `Nothing matched “${debounced.trim()}”. Try fewer words, or browse ${(TYPES.find((t) => t.key === type)?.label ?? 'everything').toLowerCase()}.`
                    : 'Nothing here right now — check back soon.'
                }
              />
            ) : (
              <FlatList
                data={results}
                keyExtractor={(v) => v.id}
                contentContainerStyle={{ padding: space['2xl'], gap: space.md, paddingBottom: space['3xl'] }}
                ListHeaderComponent={
                  <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
                    {results.length} {results.length === 1 ? 'place' : 'places'}
                  </T>
                }
                renderItem={({ item: v }) => (
                  <VendorRow
                    image={vendorImage(v)}
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
          ) : (
            <View style={{ flex: 1, paddingHorizontal: space['2xl'], paddingTop: space.xl }}>
              <SectionHeader title="Sort by" />
              <View style={{ marginTop: space.md }}>
                {SORTS.map((s) => (
                  <Pressable
                    key={s.label}
                    onPress={() => setDraftSort(s.key)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}
                  >
                    <Radio on={draftSort === s.key} />
                    <T variant="body">{s.label}</T>
                  </Pressable>
                ))}
              </View>
              <View style={{ flex: 1 }} />
              <View style={{ gap: space.md, paddingBottom: space['2xl'] }}>
                <PillButton
                  label="Apply"
                  onPress={() => {
                    setSort(draftSort);
                    setTab('result');
                  }}
                />
                <PillButton
                  label="Reset"
                  variant="soft"
                  onPress={() => {
                    setDraftSort(undefined);
                    setSort(undefined);
                    setTab('result');
                  }}
                />
              </View>
            </View>
          )}
        </>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingTop: space['2xl'], paddingBottom: space['3xl'] }}>
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
              <View style={{ gap: space.md, marginTop: space.lg }}>
                {popularItems.slice(0, 6).map((it) => (
                  <VendorRow
                    key={it.id}
                    image={itemImage(it)}
                    name={it.name}
                    sub={it.vendorName}
                    trailing={<Money amount={it.price} tone="brand" />}
                    onPress={() => navigation.navigate('MenuItem', { itemId: it.id, vendorId: it.vendorId })}
                  />
                ))}
              </View>
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
