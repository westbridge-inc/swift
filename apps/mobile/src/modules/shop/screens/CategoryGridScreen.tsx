/** @jsxImportSource react */
import React from 'react';
import { ScrollView, Pressable, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { useDiscoveryCategories } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { EmptyState, ErrorState, Header, LoadingBlock, Screen, T } from '../../../kit';

// ---------------------------------------------------------------------------
// "See all →" (#17 6.1): the full category grid, grouped by kind — the same
// blush-tile language as the rail. Only categories with open stores appear
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
  const { latitude, longitude } = useLocationStore();
  const railQ = useDiscoveryCategories(latitude ?? undefined, longitude ?? undefined);

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
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                {cats.map((c) => (
                  <Pressable
                    key={c.slug}
                    onPress={() => navigation.navigate('CategoryFeed', { slug: c.slug, name: c.name, emoji: c.emoji })}
                    accessibilityRole="button"
                    accessibilityLabel={c.name}
                  >
                    {({ pressed }) => (
                      <View style={{ width: 76, alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
                        <View
                          style={{
                            width: 64,
                            height: 64,
                            borderRadius: radius.xl,
                            backgroundColor: color.brand[50],
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <T style={{ fontSize: 30, lineHeight: 38 }}>{c.emoji}</T>
                        </View>
                        <T variant="caption" center numberOfLines={2} style={{ marginTop: space.xs }}>
                          {c.name}
                        </T>
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
