/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { useDiscoveryCategories, type DiscoveryRail } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { EmptyState, ErrorState, Header, LoadingBlock, Screen, T } from '../../../kit';
import { DiscoveryCategoryCard } from '../DiscoveryCategoryCard';

// ---------------------------------------------------------------------------
// The full category directory, grouped by kind and built from the exact same
// market-ticket component as Home. Only categories with open stores appear
// (law D holds upstream), so every tap lands somewhere real.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  CUISINE: 'Cuisines',
  DISH: 'Dishes & cravings',
  DIETARY: 'Dietary',
  AISLE: 'Grocery aisles',
  RETAIL: 'Shops',
};

export function CategoryGridScreen() {
  const navigation = useNavigation<any>();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const railQ = useDiscoveryCategories({
    vertical: 'FOOD',
    lat: locationFix?.latitude,
    lng: locationFix?.longitude,
  });
  const openCategory = React.useCallback(
    (category: DiscoveryRail['categories'][number]) => {
      navigation.navigate('CategoryFeed', { slug: category.slug, fallbackName: category.name });
    },
    [navigation],
  );

  const categories = railQ.data?.categories ?? [];
  const groups = Object.entries(
    categories.reduce<Record<string, typeof categories>>((acc, c) => {
      (acc[c.kind] = acc[c.kind] ?? []).push(c);
      return acc;
    }, {}),
  );

  return (
    <Screen>
      <Header title="Browse by category" />
      {railQ.isLoading ? (
        <LoadingBlock />
      ) : railQ.isError || !railQ.data?.enabled ? (
        <ErrorState onRetry={() => railQ.refetch()} />
      ) : categories.length === 0 ? (
        <EmptyState icon="grid" title="Nothing to browse right now" body="Categories appear here as stores open." />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          {groups.map(([kind, cats]) => (
            <View key={kind} style={{ marginTop: space.xl }}>
              <T variant="body" weight="semibold" style={{ marginBottom: space.md }}>
                {KIND_LABEL[kind] ?? kind}
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
                {cats.map((c) => (
                  <DiscoveryCategoryCard
                    key={c.slug}
                    category={c}
                    variant="grid"
                    onSelect={openCategory}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
