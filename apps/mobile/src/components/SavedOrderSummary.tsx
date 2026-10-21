import { View } from 'react-native';
import { space } from '@swift/ui';
import { Card, PillButton, T } from '../kit';
import { orderStatusLabel, presentedVertical } from '../lib/orderStatus';

/** Saved order summaries never expose payment, cancellation or live controls. */
export function SavedOrderSummary({ order, onOpen }: { order: any; onOpen?: () => void }) {
  return <View style={{ padding: space.lg }}><Card>
    <T variant="heading">Saved order {order.orderNumber ? `#${order.orderNumber}` : ''}</T>
    <T variant="body">{order.vendor?.name ?? 'Your order'}</T>
    <T variant="caption" tone="muted">Last saved status: {orderStatusLabel(order.status, presentedVertical(order))}</T>
    <T variant="caption" tone="muted">Reconnect to refresh tracking and order details.</T>
    {onOpen ? <PillButton label="View saved order" onPress={onOpen} /> : null}
  </Card></View>;
}
