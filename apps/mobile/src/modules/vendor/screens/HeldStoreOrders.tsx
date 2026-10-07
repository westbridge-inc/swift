/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { color, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Card, PillButton, T } from '../../../kit';
import { useVendorOrders } from '../../../hooks/vendorops';
import { heldStoreOrders } from '../../../lib/vendorProfile';
import { OrderStatusPill } from '../shared';

/**
 * [NO-DEAD-ENDS · owner ruling 1 Oct ~22:10] "Suspended store: accepted
 * orders are completed; new orders are blocked until it pays."
 *
 * The server has let a fee-held store finish what it accepted since #1481,
 * but the app replaced the whole dashboard with "New orders are paused", for
 * every role, so the kitchen could not reach the orders it was cooking. This
 * is the door: the open orders, each one tap from the order screen that can
 * finish it (fee hold) or decline it (any hold), so no customer is left
 * waiting on a store that cannot move.
 */
export function HeldStoreOrders({ canFinishAccepted, navigation }: { canFinishAccepted: boolean; navigation: any }) {
  const ordersQ = useVendorOrders(true);
  const { accepted, waiting } = heldStoreOrders(ordersQ.data);
  const open = (order: any) => navigation?.navigate?.('VendorOrderDetail', { orderId: order.id, orderNumber: order.orderNumber });

  if (ordersQ.isError && !ordersQ.data) {
    return (
      <Card testID="held-orders-unavailable" style={{ marginBottom: space.lg }}>
        <T variant="label" weight="semibold">Your orders couldn’t load</T>
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          This is not an empty queue. Check your connection and try again.
        </T>
        <PillButton
          testID="held-orders-retry"
          label="Try again"
          variant="soft"
          size="md"
          style={{ marginTop: space.md, alignSelf: 'flex-start' }}
          onPress={() => { void ordersQ.refetch(); }}
        />
      </Card>
    );
  }
  if (accepted.length === 0 && waiting.length === 0) return null;

  return (
    <View style={{ marginBottom: space.lg }}>
      {accepted.length > 0 ? (
        <View testID="held-orders-accepted" style={{ marginBottom: space.lg }}>
          <T variant="label" weight="semibold">
            {canFinishAccepted ? 'Finish the orders you already accepted' : 'Orders already in progress'}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs, marginBottom: space.sm }}>
            {canFinishAccepted
              ? 'The pause stops new orders only. Open each order to finish it.'
              // [DS781 S2] The board offers Reject only for new orders, so an
              // order already in progress has no decline here: a person does.
              : 'This store can’t move these orders right now. Use Ask Swift support above so a person can sort them out with you, and no customer is left waiting.'}
          </T>
          {accepted.map((order) => <HeldOrderRow key={order.id} order={order} onPress={() => open(order)} />)}
        </View>
      ) : null}
      {waiting.length > 0 ? (
        <View testID="held-orders-waiting">
          <T variant="label" weight="semibold">New orders waiting</T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs, marginBottom: space.sm }}>
            These can’t be accepted right now. Open each one to decline it, so the customer can order elsewhere.
          </T>
          {waiting.map((order) => <HeldOrderRow key={order.id} order={order} onPress={() => open(order)} />)}
        </View>
      ) : null}
    </View>
  );
}

function HeldOrderRow({ order, onPress }: { order: any; onPress: () => void }) {
  const items = order.itemCount ?? order.items?.length ?? 0;
  return (
    <Pressable
      testID={`held-order-${order.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open order ${order.orderNumber ?? ''}`.trim()}
      onPress={onPress}
    >
      <Card style={{ marginBottom: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <T variant="body" weight="bold">{order.orderNumber ? `#${order.orderNumber}` : 'Order'}</T>
          {items ? (
            <T variant="caption" tone="muted">{`${items} item${items === 1 ? '' : 's'}`}</T>
          ) : null}
        </View>
        <OrderStatusPill status={order.status} />
        <Feather name="chevron-right" size={16} color={color.text.muted} />
      </Card>
    </Pressable>
  );
}
