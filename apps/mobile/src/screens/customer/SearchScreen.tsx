import { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, FlatList, Pressable, TextInput, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { Text, Heading, Skeleton } from '../../components/ui';
import { VendorCard, type Vendor } from '../../components/customer/VendorCard';
import { useVendors } from '../../hooks';
import { useLocationStore } from '../../stores/locationStore';

const FILTERS: { key: string; label: string; type?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'food', label: 'Food', type: 'RESTAURANT' },
  { key: 'grocery', label: 'Groceries', type: 'SUPERMARKET' },
  { key: 'shops', label: 'Shops', type: 'STORE' },
  { key: 'services', label: 'Services', type: 'SERVICE' },
];

export function SearchScreen({ navigation }: any) {
  const { latitude, longitude } = useLocationStore();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState('all');

  // Debounce keystrokes → one query when typing settles.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const params = useMemo(() => {
    const p: Record<string, string> = { sort: 'rating' };
    if (debounced) p['search'] = debounced;
    const type = FILTERS.find((f) => f.key === filter)?.type;
    if (type) p['type'] = type;
    if (latitude != null && longitude != null) {
      p['lat'] = String(latitude);
      p['lng'] = String(longitude);
    }
    return p;
  }, [debounced, filter, latitude, longitude]);

  const { data, isLoading, isError, refetch, isRefetching } = useVendors<Vendor[]>(params);
  const vendors = data ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="px-lg pb-sm pt-md">
        <Heading size="2xl">Explore</Heading>
      </View>

      {/* Search field */}
      <View className="mx-lg mb-md flex-row items-center rounded-full border border-border-subtle bg-surface-subtle px-lg">
        <Text className="text-text-muted">🔍</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Search food, shops, services…"
          placeholderTextColor={color.text.muted}
          returnKeyType="search"
          className="ml-sm flex-1 py-md font-body text-base text-text-primary"
        />
        {text ? (
          <Pressable onPress={() => setText('')} hitSlop={8}>
            <Text className="text-text-muted">✕</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Category chips */}
      <View className="mb-sm">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {FILTERS.map((item) => {
            const active = item.key === filter;
            return (
              <Pressable
                key={item.key}
                onPress={() => setFilter(item.key)}
                className={
                  active
                    ? 'rounded-full border border-brand-500 bg-brand-500 px-lg py-sm'
                    : 'rounded-full border border-border-subtle bg-surface-base px-lg py-sm'
                }
              >
                <Text
                  className={
                    active ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-text-secondary'
                  }
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Results */}
      {isLoading ? (
        <View className="px-lg pt-sm">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="mb-md h-20 w-full" />
          ))}
        </View>
      ) : isError ? (
        <View className="flex-1 items-center justify-center px-2xl">
          <Text className="text-3xl">⚠️</Text>
          <Text className="mt-sm text-center text-text-secondary">Couldn&apos;t load places.</Text>
          <Pressable onPress={() => refetch()} className="mt-md rounded-full bg-brand-500 px-xl py-sm">
            <Text className="font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={vendors}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, paddingTop: 4 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />
          }
          renderItem={({ item }) => (
            <VendorCard vendor={item} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
          )}
          ListEmptyComponent={
            <View className="items-center justify-center px-2xl pt-5xl">
              <Text className="text-3xl">🔎</Text>
              <Text className="mt-sm text-center text-text-secondary">
                {debounced ? `No results for “${debounced}”.` : 'Nothing here yet — check back soon.'}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
