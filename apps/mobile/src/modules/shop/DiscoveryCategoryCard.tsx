/** @jsxImportSource react */
import React, { memo, useCallback } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';
import type { DiscoveryRail } from '../../hooks/customer';
import { PressableScale, T } from '../../kit';
import { VERTICAL_TINT } from '../../kit/vertical-tint';
import { categoryKindLabel, categoryTintKey } from './category-presentation';

export type DiscoveryCategory = DiscoveryRail['categories'][number];

export const DISCOVERY_RAIL_CARD_WIDTH = 148;
export const DISCOVERY_RAIL_CARD_GAP = space.md;

type Props = {
  category: DiscoveryCategory;
  onSelect: (category: DiscoveryCategory) => void;
  variant?: 'rail' | 'grid';
  style?: StyleProp<ViewStyle>;
};

/**
 * The customer category ticket.
 *
 * It is deliberately text-first: category kind, actual name and Swift's
 * vertical accent. There is no invented photography, generated acronym art,
 * or OS-dependent emoji.
 */
export const DiscoveryCategoryCard = memo(function DiscoveryCategoryCard({
  category,
  onSelect,
  variant = 'rail',
  style,
}: Props) {
  const tint = VERTICAL_TINT[categoryTintKey(category.vertical)] ?? {
    bg: color.surface.sunken,
    ink: color.text.primary,
  };
  const kind = categoryKindLabel(category.kind);
  const handlePress = useCallback(() => onSelect(category), [category, onSelect]);

  return (
    <PressableScale
      strong
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={category.name}
      accessibilityHint={`Browse ${kind.toLowerCase()}`}
      testID={`discovery-category-${category.slug}`}
      style={[
        variant === 'rail'
          ? { width: DISCOVERY_RAIL_CARD_WIDTH }
          : { flexBasis: '47%', maxWidth: '47%', flexGrow: 0 },
        style,
      ]}
    >
      <View
        style={{
          minHeight: variant === 'rail' ? 88 : 96,
          borderRadius: radius.lg,
          backgroundColor: tint.bg,
          padding: space.md,
          flexDirection: 'row',
          alignItems: 'stretch',
          gap: space.md,
          overflow: 'hidden',
        }}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 3,
            borderRadius: radius.full,
            backgroundColor: tint.ink,
            opacity: 0.82,
          }}
        />
        <View style={{ flex: 1, justifyContent: 'space-between', minWidth: 0 }}>
          <T variant="micro" numberOfLines={1} style={{ color: tint.ink }}>
            {kind.toUpperCase()}
          </T>
          <T variant="bodyStrong" numberOfLines={2}>
            {category.name}
          </T>
        </View>
      </View>
    </PressableScale>
  );
});

export function BrowseAllCategoryCard({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <PressableScale
      strong
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Browse all ${count} categories`}
      accessibilityHint="Opens the complete category directory"
      style={{ width: DISCOVERY_RAIL_CARD_WIDTH }}
    >
      <View
        style={{
          minHeight: 88,
          borderRadius: radius.lg,
          backgroundColor: color.surface.sunken,
          padding: space.md,
          justifyContent: 'space-between',
        }}
      >
        <T variant="bodyStrong">Browse all</T>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.sm }}>
          <T variant="caption" tone="muted">Full directory</T>
          <T variant="numM" tone="deep">{count}</T>
        </View>
      </View>
    </PressableScale>
  );
}
