/** @jsxImportSource react */
import React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { color, fontSize, radius, space } from '@swift/ui';
import { T } from '../../kit';
import type { DiscoveryRail } from '../../hooks/customer';

// ---------------------------------------------------------------------------
// The category rail (#17 6.1) — at the founder's X: below the quick-action
// tiles, above the promo banner. Chip anatomy per spec: blush rounded tile
// ~64×64 (the quick-action tile language), emoji at 30pt, caption beneath,
// block ~76 wide, 12 gap. Law D upstream guarantees every chip leads to open
// stores; fewer than CAT_RAIL_MIN_CHIPS (4) → the rail is absent entirely and
// Home renders exactly as the flag-off baseline (CAT-G).
// ---------------------------------------------------------------------------

export const CAT_RAIL_MIN_CHIPS = 4;

const TILE = 64;
const BLOCK_W = 76;

function ChipTile({ emoji, label, onPress }: { emoji: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {({ pressed }) => (
        <View style={{ width: BLOCK_W, alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
          <View
            style={{
              width: TILE,
              height: TILE,
              borderRadius: radius.xl,
              backgroundColor: color.brand[50],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Emoji glyph metric, derived from the scale. */}
            <T style={{ fontSize: fontSize.base * 2, lineHeight: fontSize.base * 2 + space.sm }}>{emoji}</T>
          </View>
          <T variant="caption" center numberOfLines={2} style={{ marginTop: space.xs }}>
            {label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

/** Skeleton = 5 ghost tiles (spec 6.1 states). */
function RailSkeleton() {
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: space['2xl'] }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} style={{ width: BLOCK_W, alignItems: 'center' }}>
          <View style={{ width: TILE, height: TILE, borderRadius: radius.xl, backgroundColor: color.surface.sunken }} />
          <View style={{ width: 48, height: 10, borderRadius: radius.full, backgroundColor: color.surface.sunken, marginTop: space.xs }} />
        </View>
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
  if (loading) return <View style={{ marginTop: space.lg }}><RailSkeleton /></View>;
  // Fetch failure or flag off or too few chips → absent, silently (garnish).
  if (!data?.enabled || data.categories.length < CAT_RAIL_MIN_CHIPS) return null;

  return (
    <FlatList
      horizontal
      showsHorizontalScrollIndicator={false}
      data={data.categories}
      keyExtractor={(c) => c.slug}
      style={{ marginTop: space.lg }}
      contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: 12 }}
      renderItem={({ item }) => (
        <ChipTile emoji={item.emoji} label={item.name} onPress={() => onChip(item)} />
      )}
      ListFooterComponent={
        <Pressable onPress={onSeeAll} accessibilityRole="button" accessibilityLabel="See all categories">
          {({ pressed }) => (
            <View style={{ width: BLOCK_W, alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
              <View
                style={{
                  width: TILE,
                  height: TILE,
                  borderRadius: radius.xl,
                  backgroundColor: color.surface.sunken,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <T variant="body" weight="bold" style={{ color: color.brand[600] }}>→</T>
              </View>
              <T variant="caption" center style={{ marginTop: space.xs }}>
                See all
              </T>
            </View>
          )}
        </Pressable>
      }
    />
  );
}
