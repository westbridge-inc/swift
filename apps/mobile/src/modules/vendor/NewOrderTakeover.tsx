import React, { useEffect } from 'react';
import { Modal, ScrollView, Vibration, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T, PillButton } from '../../kit';
import { useVendorOrder, useOrderAction } from '../../hooks/vendorops';

/**
 * The NEW-ORDER takeover (alerts spec §A1): impossible to sleep through while
 * the app is open. Full-screen, order summary, two giant buttons; a strong
 * repeating buzz every 5s until acknowledged. "View later" dismisses honestly
 * — the server's escalation ladder (re-alert → SMS) still stands behind it.
 * Multiple orders stack and are worked first-in-first-out.
 */
export function NewOrderTakeover({
  queue,
  onDismiss,
}: {
  queue: Array<{ orderId: string; orderNumber?: string }>;
  onDismiss: (orderId: string) => void;
}) {
  const current = queue[0];
  const order = useVendorOrder(current?.orderId);
  const act = useOrderAction();

  // The buzz loop lives exactly as long as the takeover does.
  useEffect(() => {
    if (!current) return;
    Vibration.vibrate([0, 400, 200, 400]);
    const timer = setInterval(() => Vibration.vibrate([0, 400, 200, 400]), 5000);
    return () => {
      clearInterval(timer);
      Vibration.cancel();
    };
  }, [current?.orderId]);

  if (!current) return null;
  const o: any = order.data;
  const items: any[] = o?.items ?? [];
  const customer = o?.customer ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ') : '';
  const busy = act.isPending;

  const decide = (action: 'accept' | 'reject') =>
    act.mutate(
      { id: current.orderId, action },
      { onSuccess: () => onDismiss(current.orderId) },
    );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onDismiss(current.orderId)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <View style={{ width: '100%', maxWidth: 420, backgroundColor: color.surface.base, borderRadius: radius.xl, padding: space['2xl'], alignItems: 'center' }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
            <Feather name="bell" size={30} color={color.brand[500]} />
          </View>
          <T variant="display" tone="brand" center style={{ marginTop: space.md }}>
            {queue.length > 1 ? `${queue.length} NEW ORDERS` : 'NEW ORDER'}
          </T>
          <T variant="heading" center style={{ marginTop: space.sm }}>
            #{o?.orderNumber ?? current.orderNumber ?? '…'}
            {o?.totalAmount != null ? ` · $${Number(o.totalAmount).toLocaleString()}` : ''}
          </T>
          {customer ? (
            <T variant="label" tone="muted" center style={{ marginTop: 2 }}>
              {customer} · {items.length} item{items.length === 1 ? '' : 's'} · {o?.fulfillment === 'PICKUP' ? 'pickup' : 'delivery'}
            </T>
          ) : null}

          <ScrollView style={{ maxHeight: 140, alignSelf: 'stretch', marginTop: space.md }}>
            {items.map((i) => (
              <T key={i.id} variant="label" tone="muted" style={{ marginTop: 2 }}>
                {i.quantity}× {i.name}
              </T>
            ))}
          </ScrollView>

          <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
            <PillButton label="Accept" loading={busy} onPress={() => decide('accept')} />
            <PillButton label="Reject" variant="soft" disabled={busy} onPress={() => decide('reject')} />
          </View>
          {act.isError ? (
            <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
              {(act.error as any)?.response?.data?.error?.message ?? 'That didn’t work — try again.'}
            </T>
          ) : null}
          <T
            variant="caption"
            tone="muted"
            center
            style={{ marginTop: space.md, textDecorationLine: 'underline' }}
            onPress={() => onDismiss(current.orderId)}
          >
            View later — the order stays on your board
          </T>
        </View>
      </View>
    </Modal>
  );
}
