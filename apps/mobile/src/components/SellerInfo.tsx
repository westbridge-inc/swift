/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { T } from '../kit';
import { sellerFacts, type StorefrontSeller } from '../lib/sellerInfo';

/**
 * [R3 · CAA s.70] Who sells, how payment works and the store's refund rule, at the foot of every store page — the
 * rows come from lib/sellerInfo (one wording with the website); "Ask the store" stands in for anything not on file.
 */
export function SellerInfo({ seller, gutter }: { seller: StorefrontSeller; gutter: number }) {
  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel="Seller information"
      style={{
        marginHorizontal: gutter,
        marginTop: space['3xl'],
        padding: space.lg,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: color.border.subtle,
        backgroundColor: color.surface.base,
        gap: space.md,
      }}
    >
      <T variant="label" weight="semibold">Seller information</T>
      {sellerFacts(seller).map((fact) => (
        <View key={fact.label} style={{ gap: 2 }}>
          <T variant="caption" tone="muted">{fact.label}</T>
          <T variant="body">{fact.value}</T>
        </View>
      ))}
      <T variant="caption" tone="muted">{seller.statutoryRights}</T>
    </View>
  );
}
