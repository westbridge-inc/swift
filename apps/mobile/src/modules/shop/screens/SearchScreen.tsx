import { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Skeleton, List, Input, PressableScale, EmptyState } from '../../../components/ui';
import { VendorRow } from '../../../components/customer/VendorCards';
import { useVendors } from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';

const FILTERS: { key: string; label: string; type?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'food', label: 'Food', type: 'RESTAURANT' },
  { key: 'grocery', label: 'Groceries', type: 'SUPERMARKET' },
  { key: 'shops', label: 'Shops', type: 'STORE' },
  { key: 'services', label: 'Services', type: 'SERVICE' },
];

const SORTS: { key: 'recommended' | 'popular' | 'name'; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'popular', label: 'Popular' },
  { key: 'name', label: 'A–Z' },
];

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      className={active ? 'rounded-full border px-lg py-sm' : 'rounded-full border border-border-subtle bg-surface-base px-lg py-sm'}
      style={active ? { backgroundColor: color.brand[500], borderColor: color.brand[500] } : undefined}
    >
      <Text className={active ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-text-secondary'}>{label}</Text>
    </PressableScale>
  );
}

export function SearchScreen({ navigation }: any) {
  const { latitude, longitude } = useLocationStore();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<'recommended' | 'popular' | 'name'>('recommended');
  const [openNow, setOpenNow] = useState(false);
  const [topRated, setTopRated] = useState(false);

  // Debounce keystrokes → one query when typing settles.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const params = useMemo(() => {
    const sortParam = sort === 'popular' ? 'popular' : sort === 'name' ? 'name' : 'rating';
    const p: Record<string, string> = { sort: sortParam };
    if (debounced) p['search'] = debounced;
    const type = FILTERS.find((f) => f.key === filter)?.type;
    if (type) p['type'] = type;
    if (openNow) p['open'] = 'true';
    if (topRated) p['minRating'] = '4.5';
    if (latitude != null && longitude != null) {
      p['lat'] = String(latitude);
      p['lng'] = String(longitude);
    }
    return p;
  }, [debounced, filter, sort, openNow, topRated, latitude, longitude]);

  const { data, isLoading, isError, refetch, isRefetching } = useVendors<any[]>(params);
  const vendors = data ?? [];

  return (
    // Kit search screens are light-first: title + field on paper, no canopy.
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.subtle }} edges={['top']}>
      <View className="px-lg pb-md pt-md">
        <Text className="font-display font-extrabold text-text-primary" style={{ fontSize: 26, lineHeight: 32 }}>
          Search
        </Text>
        <Text className="mt-xs text-text-secondary" style={{ fontSize: 14 }}>
          Discover food, groceries, shops and services
        </Text>
        <View style={{ marginTop: 12 }}>
          <Input
            value={text}
            onChangeText={setText}
            placeholder="Search food, shops, services…"
            returnKeyType="search"
            left={<Feather name="search" size={18} color={color.brand[500]} style={{ marginRight: 8 }} />}
            right={
              text ? (
                <PressableScale onPress={() => setText('')} hitSlop={8}>
                  <Feather name="x" size={18} color={color.text.muted} />
                </PressableScale>
              ) : null
            }
          />
        </View>
      </View>

      <View className="bg-surface-subtle" style={{ flex: 1 }}>

      {/* Category chips */}
      <View className="mb-sm">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {FILTERS.map((item) => {
            const active = item.key === filter;
            return (
              <PressableScale
                key={item.key}
                onPress={() => setFilter(item.key)}
                className={
                  active
                    ? 'rounded-full border px-lg py-sm'
                    : 'rounded-full border border-border-subtle bg-surface-base px-lg py-sm'
                }
                style={active ? { backgroundColor: color.brand[500], borderColor: color.brand[500] } : undefined}
              >
                <Text className={active ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-text-secondary'}>
                  {item.label}
                </Text>
              </PressableScale>
            );
          })}
        </ScrollView>
      </View>

      {/* Filters + sort (all wired to real backend params) */}
      <View className="mb-sm">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}>
          <Pill label="Open now" active={openNow} onPress={() => setOpenNow((v) => !v)} />
          <Pill label="Top rated" active={topRated} onPress={() => setTopRated((v) => !v)} />
          <View style={{ width: 1, height: 20, backgroundColor: color.border.subtle, marginHorizontal: 4 }} />
          {SORTS.map((s) => (
            <Pill key={s.key} label={s.label} active={sort === s.key} onPress={() => setSort(s.key)} />
          ))}
        </ScrollView>
      </View>

      {/* Results */}
      <View style={{ flex: 1 }}>
        {isLoading ? (
          <View className="px-lg pt-sm">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="mb-md h-28 w-full" style={{ borderRadius: 12 }} />
            ))}
          </View>
        ) : isError ? (
          <View className="flex-1 items-center justify-center">
            <EmptyState
              icon="alert-circle-outline"
              title="Couldn’t load places"
              body="Something went wrong — give it another go."
              actionLabel="Retry"
              onAction={() => refetch()}
            />
          </View>
        ) : (
          <List
            data={vendors}
            keyExtractor={(v: any) => String(v.id)}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, paddingTop: 4 }}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
            renderItem={({ item }: { item: any }) => (
              <VendorRow vendor={item} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
            )}
            ListEmptyComponent={
              <View className="pt-2xl">
                <EmptyState
                  icon="magnify"
                  title={debounced ? 'No matches' : 'Search Swift'}
                  body={
                    debounced
                      ? `Nothing for “${debounced}” — try another term.`
                      : 'Find food, groceries, shops and services near you.'
                  }
                />
              </View>
            }
          />
        )}
      </View>
      </View>
    </SafeAreaView>
  );
}
