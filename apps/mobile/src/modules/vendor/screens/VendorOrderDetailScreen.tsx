/** @jsxImportSource react */
import React, { useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, IconChip, InfoRow, LoadingBlock, ErrorState, PillButton, PopupCard, Screen, T } from '../../../kit';
import { useOrderAction, useVendorOrder } from '../../../hooks/vendorops';
import { money } from '../../../lib/money';
import {
  FulfillmentTag,
  GUTTER,
  OrderStatusPill,
  SubHeader,
  fmtClock,
  fmtWhen,
  formatSlot,
  orderActions,
  prettyStatus,
} from '../shared';

/** One row of the immutable status log — evidence-grade order history. */
function TimelineRow({ entry, last }: { entry: any; last: boolean }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: 24, alignItems: 'center' }}>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            marginTop: 5,
            backgroundColor: (entry.status || '').toUpperCase() === 'CANCELLED' ? color.error : color.brand[500],
          }}
        />
        {!last ? <View style={{ flex: 1, width: 2, marginVertical: 3, borderRadius: 1, backgroundColor: color.border.subtle }} /> : null}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T variant="label" weight="semibold">
            {prettyStatus(entry.status)}
          </T>
          <T variant="caption" tone="muted">
            {fmtWhen(entry.createdAt)}
          </T>
        </View>
        {entry.note ? (
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {entry.note}
          </T>
        ) : null}
      </View>
    </View>
  );
}

function ContactCard({
  icon,
  title,
  name,
  phone,
  lines,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  name: string;
  phone?: string;
  lines?: (string | null | undefined)[];
}) {
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
          <MaterialCommunityIcons name={icon} size={20} color={color.brand[600]} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="caption" weight="bold" tone="muted">
            {title.toUpperCase()}
          </T>
          <T variant="body" weight="semibold" numberOfLines={1}>
            {name}
          </T>
        </View>
        {phone ? (
          <PillButton label="Call" variant="soft" size="sm" onPress={() => Linking.openURL(`tel:${phone}`).catch(() => {})} />
        ) : null}
      </View>
      {(lines ?? []).filter(Boolean).map((l, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: i === 0 ? space.md : 4 }}>
          <Feather name={i === 0 ? 'map-pin' : 'message-square'} size={13} color={color.text.muted} style={{ marginTop: 2 }} />
          <T variant="label" tone="muted" style={{ flex: 1 }}>
            {l}
          </T>
        </View>
      ))}
    </Card>
  );
}

export function VendorOrderDetailScreen({ navigation, route }: any) {
  const orderId: string | undefined = route.params?.orderId;
  const { data: order, isLoading, isError, refetch } = useVendorOrder(orderId);
  const orderAction = useOrderAction();
  const [confirmReject, setConfirmReject] = useState(false);

  if (isLoading || !orderId) {
    return (
      <Screen>
        <SubHeader title={route.params?.orderNumber ? `#${route.params.orderNumber}` : 'Order'} navigation={navigation} />
        <LoadingBlock />
      </Screen>
    );
  }
  if (isError || !order) {
    return (
      <Screen>
        <SubHeader title="Order" navigation={navigation} />
        <ErrorState onRetry={refetch} />
      </Screen>
    );
  }

  const items: any[] = order.items ?? [];
  const s = (order.status || '').toUpperCase();
  const terminal = ['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(s);
  const isPickup = order.fulfillment === 'PICKUP';
  const isAppt = order.fulfillment === 'APPOINTMENT';
  const apptMobile = isAppt && !!order.deliveryAddress && order.deliveryAddress !== order.pickupAddress;
  const actions = orderActions(order);
  const busy = orderAction.isPending;
  // The log is stored newest-first; the timeline reads placed → latest.
  const timeline: any[] = [...(order.statusHistory ?? [])].reverse();
  const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const riderName = [order.rider?.user?.firstName, order.rider?.user?.lastName].filter(Boolean).join(' ');

  const runAction = (action: (typeof actions)[number]['action']) => {
    if (action === 'reject') {
      setConfirmReject(true);
      return;
    }
    orderAction.mutate({ id: order.id, action });
  };

  return (
    <Screen>
      <SubHeader title={order.orderNumber ? `#${order.orderNumber}` : 'Order'} navigation={navigation} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: actions.length ? 140 : space['3xl'] }}
        showsVerticalScrollIndicator={false}
      >
        {/* Status line */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md }}>
          <OrderStatusPill status={order.status} />
          {isPickup ? (
            <FulfillmentTag icon="bag-personal-outline" label="Takeaway" />
          ) : isAppt ? (
            <FulfillmentTag icon="calendar-clock" label="Appointment" />
          ) : (
            <FulfillmentTag icon="bike-fast" label="Delivery" />
          )}
          <T variant="caption" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
            {fmtWhen(order.placedAt)}
          </T>
        </View>

        {/* Risk flag — surfaced exactly as the trust engine recorded it */}
        {order.riskFlagged ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: space.md,
              borderRadius: radius.lg,
              backgroundColor: '#FDF1DC',
              padding: space.lg,
              marginBottom: space.md,
            }}
          >
            <Feather name="alert-triangle" size={18} color={color.warning} />
            <T variant="label" style={{ flex: 1 }}>
              Flagged for review{order.riskReason ? ` — ${order.riskReason}` : ''}. Confirm payment before handover.
            </T>
          </View>
        ) : null}

        {/* Takeaway code — the handover gate for counter pickups */}
        {isPickup && order.pickupCode && !terminal ? (
          <Card style={{ alignItems: 'center', marginBottom: space.md }}>
            <T variant="caption" weight="bold" tone="muted">
              PICKUP CODE
            </T>
            <T variant="display" tone="brand" style={{ letterSpacing: 6, marginTop: 2 }}>
              {order.pickupCode}
            </T>
            <T variant="caption" tone="muted" center style={{ marginTop: 2 }}>
              Ask the customer for this code — and take payment — before handing over.
            </T>
          </Card>
        ) : null}

        {/* Line items */}
        <Card style={{ marginBottom: space.md }}>
          <T variant="body" weight="semibold" style={{ marginBottom: space.sm }}>
            {items.length} item{items.length === 1 ? '' : 's'}
          </T>
          {items.map((it) => (
            <View key={it.id} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6 }}>
              <T variant="label" weight="bold" tone="brand" style={{ width: 34 }}>
                {it.quantity}×
              </T>
              <View style={{ flex: 1, paddingRight: space.md }}>
                <T variant="label" weight="semibold">
                  {it.name}
                </T>
                {it.specialInstructions ? (
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    “{it.specialInstructions}”
                  </T>
                ) : null}
                {it.quantity > 1 ? (
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    {money(it.basePrice)} each
                  </T>
                ) : null}
              </View>
              <T variant="label" weight="semibold">
                {money(it.totalBase)}
              </T>
            </View>
          ))}
        </Card>

        {/* Money — recorded amounts only (cash model: payment before handover) */}
        <Card style={{ marginBottom: space.md }}>
          <InfoRow label="Items" value={money(order.subtotalBase)} />
          {Number(order.deliveryFee) > 0 ? <InfoRow label="Delivery fee (rider's)" value={money(order.deliveryFee)} /> : null}
          {Number(order.tipAmount) > 0 ? <InfoRow label="Tip" value={money(order.tipAmount)} /> : null}
          {Number(order.discount) > 0 ? <InfoRow label="Promo discount" value={`-${money(order.discount)}`} /> : null}
          <InfoRow label="Customer pays" value={money(order.totalAmount)} strong />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm }}>
            <MaterialCommunityIcons name="cash" size={16} color={color.success} />
            <T variant="caption" weight="semibold" tone="muted">
              {order.paymentMethod === 'CASH' ? 'Cash on handover — you keep 100% of the goods total.' : String(order.paymentMethod ?? '')}
            </T>
          </View>
        </Card>

        {/* Cancellation — reason straight off the order record */}
        {s === 'CANCELLED' ? (
          <View style={{ borderRadius: radius.lg, backgroundColor: '#FDECEC', padding: space.lg, marginBottom: space.md }}>
            <T variant="label" weight="semibold" tone="error">
              Cancelled {fmtWhen(order.cancelledAt)}
            </T>
            {order.cancellationReason ? (
              <T variant="label" tone="muted" style={{ marginTop: 4 }}>
                {order.cancellationReason}
              </T>
            ) : null}
          </View>
        ) : null}

        {/* Customer */}
        <ContactCard
          icon="account"
          title="Customer"
          name={customerName}
          phone={order.customer?.phone}
          lines={
            isAppt
              ? [formatSlot(order.appointmentSlot), apptMobile ? `You travel to: ${order.deliveryAddress}` : 'At your store']
              : isPickup
                ? ['Collects at the counter']
                : [order.deliveryAddress, order.deliveryInstructions]
          }
        />

        {/* Rider — only once dispatch has assigned one */}
        {riderName ? <ContactCard icon="bike" title="Rider" name={riderName} phone={order.rider?.user?.phone} /> : null}

        {/* Immutable status log */}
        {timeline.length > 0 ? (
          <Card style={{ marginBottom: space.md }}>
            <T variant="body" weight="semibold" style={{ marginBottom: space.md }}>
              Timeline
            </T>
            {timeline.map((e, i) => (
              <TimelineRow key={e.id ?? i} entry={e} last={i === timeline.length - 1} />
            ))}
          </Card>
        ) : null}

        {/* Prep expectations, when set */}
        {order.estimatedPrepTime ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.md }}>
            <Feather name="clock" size={13} color={color.text.muted} />
            <T variant="caption" tone="muted">
              Quoted prep time: {order.estimatedPrepTime} min
              {order.readyAt && order.acceptedAt
                ? ` · actual ${Math.max(1, Math.round((new Date(order.readyAt).getTime() - new Date(order.acceptedAt).getTime()) / 60000))} min (ready ${fmtClock(order.readyAt)})`
                : ''}
            </T>
          </View>
        ) : null}
      </ScrollView>

      {/* Action bar — same transitions as the board */}
      {actions.length > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: 'row',
            gap: space.md,
            backgroundColor: color.surface.base,
            borderTopWidth: 1,
            borderTopColor: color.border.subtle,
            paddingHorizontal: GUTTER,
            paddingTop: space.lg,
            paddingBottom: space['2xl'],
          }}
        >
          {actions.map((a) => (
            <PillButton
              key={a.action}
              label={a.label}
              variant={a.action === 'reject' ? 'outline' : 'primary'}
              style={{ flex: 1 }}
              disabled={busy}
              loading={busy && a.action !== 'reject'}
              onPress={() => runAction(a.action)}
            />
          ))}
        </View>
      ) : null}

      {/* Reject confirm — destructive, so it gets the kit popup */}
      <PopupCard visible={confirmReject} onClose={() => setConfirmReject(false)}>
        <IconChip icon="x-circle" size={56} tone="error" />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Reject this order?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          The customer is told right away. This can&apos;t be undone.
        </T>
        <PillButton
          label="Reject order"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setConfirmReject(false);
            orderAction.mutate({ id: order.id, action: 'reject' });
          }}
        />
        <PillButton label="Keep it" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmReject(false)} />
      </PopupCard>
    </Screen>
  );
}
