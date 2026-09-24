/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, space } from '@swift/ui';
import { useCart } from '../hooks/customer';
import { Money } from './money';
import { T } from './text';

const GUTTER = space['2xl'];
/** The pill's height, from the storefront's geometry. */
export const CART_BAR_HEIGHT = 52;

/** Items in the basket, and whether the bar shows for this surface. */
function cartBarState(data: any, vendorId?: string): { count: number; visible: boolean } {
  const lines: any[] = data?.items ?? [];
  const count = lines.reduce((n, l) => n + (l.quantity ?? 0), 0);
  return { count, visible: count > 0 && (vendorId === undefined || data?.vendorId === vendorId) };
}

/**
 * [E09] The room a scrolling list must leave at its bottom while the bar
 * floats over it — the bar's whole footprint above the screen edge — so the
 * last row can always scroll clear of it and be tapped. Zero while the bar is
 * hidden, so an empty basket changes no layout.
 */
export function useCartBarClearance({ vendorId }: { vendorId?: string } = {}): number {
  const insets = useSafeAreaInsets();
  const cart = useCart<any>();
  return cartBarState(cart.data, vendorId).visible ? insets.bottom + space.lg + CART_BAR_HEIGHT : 0;
}

/**
 * CartBar — the pinned "View cart" pill that rides above the home indicator
 * while the basket has items. Born on the restaurant storefront; extracted
 * into the kit [E09] so a shopper deep in browse (Search, CategoryFeed,
 * Nearby, Recommended) can always reach the Cart tab without backing out.
 *
 * It reads the cart through the SAME `useCart` hook every other cart surface
 * uses — the query lives under one key, so mounting the bar never issues a
 * second request. When `vendorId` is passed (the storefront), the bar shows
 * only for THAT store's basket: the cart is single-vendor and carries its
 * vendorId, so browsing another storefront never surfaces another store's
 * items.
 *
 * Placement matches the storefront exactly: absolutely positioned above the
 * safe-area bottom inset (`insets.bottom + space.lg`), spanning the paper
 * gutter, so it never sits on the home indicator or the screen's own bottom
 * chrome. The 52pt height and pill radius are the storefront's geometry.
 */
export function CartBar({ vendorId }: { vendorId?: string } = {}) {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const cart = useCart<any>();

  const { count, visible } = cartBarState(cart.data, vendorId);
  if (!visible) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View cart, ${count} item${count === 1 ? '' : 's'}`}
      onPress={() => navigation.navigate('Tabs', { screen: 'Cart' })}
    >
      {({ pressed }) => (
        <View
          style={{
            position: 'absolute',
            left: GUTTER,
            right: GUTTER,
            bottom: insets.bottom + space.lg,
            height: CART_BAR_HEIGHT,
            borderRadius: 9999,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: space.xl,
            backgroundColor: color.brand[500],
            opacity: pressed ? 0.9 : 1,
            ...elevation.floating,
          }}
        >
          <T variant="body" weight="bold" tone="onBrand">
            View cart
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
            <T variant="body" weight="bold" tone="onBrand">
              {count} item{count === 1 ? '' : 's'} ·
            </T>
            <Money amount={Number(cart.data?.subtotalCustomer ?? 0)} tone="onBrand" />
          </View>
        </View>
      )}
    </Pressable>
  );
}
