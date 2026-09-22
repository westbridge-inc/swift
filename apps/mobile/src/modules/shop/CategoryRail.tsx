/** @jsxImportSource react */
import React from 'react';
import { FlatList, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import type { DiscoveryRail } from '../../hooks/customer';
import { SectionHeader } from '../../kit';
import {
  BrowseAllCategoryCard,
  DISCOVERY_RAIL_CARD_GAP,
  DISCOVERY_RAIL_CARD_WIDTH,
  DiscoveryCategoryCard,
} from './DiscoveryCategoryCard';

// ---------------------------------------------------------------------------
// The category rail (#17 6.1) — at the founder's X: below the quick-action
// tiles, above the promo banner. The original cut rendered database emoji in
// identical blush squares. That changed visual style between iOS/Android and
// contradicted the kit's own "one hand, never emoji UI" law. The shared market
// ticket now carries a deterministic Swift mark, a name and the real open-store
// count. Law D upstream still guarantees every ticket has somewhere to land;
// fewer than CAT_RAIL_MIN_CHIPS (4) keeps the whole rail absent (CAT-G).
// ---------------------------------------------------------------------------

export const CAT_RAIL_MIN_CHIPS = 4;

/** Skeleton = 3 market tickets plus a peek, matching the live geometry. */
function RailSkeleton() {
  return (
    <View style={{ flexDirection: 'row', gap: DISCOVERY_RAIL_CARD_GAP, paddingHorizontal: space['2xl'], overflow: 'hidden' }}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{
            width: DISCOVERY_RAIL_CARD_WIDTH,
            height: 88,
            borderRadius: radius.lg,
            backgroundColor: color.surface.sunken,
          }}
        />
      ))}
    </View>
  );
}

export function CategoryRail({
  data,
  loading,
  onChip,
  onSeeAll,
}: {
  data: DiscoveryRail | undefined;
  loading: boolean;
  onChip: (c: DiscoveryRail['categories'][number]) => void;
  onSeeAll: () => void;
}) {
  if (loading) {
    return (
      <View style={{ marginTop: space['2xl'] }}>
        <SectionHeader
          eyebrow="Open near you"
          title="Browse food"
          style={{ paddingHorizontal: space['2xl'], marginBottom: space.md }}
        />
        <RailSkeleton />
      </View>
    );
  }
  // Fetch failure or flag off or too few chips → absent, silently (garnish).
  if (!data?.enabled || data.categories.length < CAT_RAIL_MIN_CHIPS) return null;

  return (
    <View style={{ marginTop: space['2xl'] }}>
      <SectionHeader
        eyebrow="Open near you"
        title="Browse food"
        onSeeAll={onSeeAll}
        style={{ paddingHorizontal: space['2xl'], marginBottom: space.md }}
      />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={data.categories}
        keyExtractor={(c) => c.slug}
        contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: DISCOVERY_RAIL_CARD_GAP }}
        initialNumToRender={4}
        maxToRenderPerBatch={5}
        windowSize={5}
        removeClippedSubviews
        getItemLayout={(_items, index) => ({
          length: DISCOVERY_RAIL_CARD_WIDTH + DISCOVERY_RAIL_CARD_GAP,
          offset: (DISCOVERY_RAIL_CARD_WIDTH + DISCOVERY_RAIL_CARD_GAP) * index,
          index,
        })}
        renderItem={({ item }) => (
          <DiscoveryCategoryCard category={item} onSelect={onChip} />
        )}
        ListFooterComponent={
          <BrowseAllCategoryCard count={data.categories.length} onPress={onSeeAll} />
        }
      />
    </View>
  );
}
