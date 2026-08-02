import React, { useEffect } from 'react';
import { Modal, ScrollView, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { color, motion, radius, space } from '@swift/ui';
import { T, Money, PillButton } from '../../kit';
import { haptic } from '../../lib/haptics';
import { useVendorOrder, useOrderAction } from '../../hooks/vendorops';

/**
 * The NEW-ORDER takeover (alerts spec §A1 + design-100× Part 5 moment 2):
 * impossible to sleep through while the app is open, decidable from across a
 * kitchen. FULL-SCREEN on the paper surface — short-code in displayXl, items
 * at heading size, total in numL, one 64dp ACCEPT. The bell tile pulses in
 * time with the strong repeating buzz (every 5s until acknowledged). "View
 * later" dismisses honestly — the server's escalation ladder (re-alert → SMS)
 * still stands behind it. Multiple orders stack, worked first-in-first-out.
 */
export function NewOrderTakeover({
  queue,
  onDismiss,
}: {
  queue: Array<{ orderId: string; orderNumber?: string }>;
  onDismiss: (orderId: string) => void;
}) {
  const current = queue[0];
  const orderId = current?.orderId;
  const order = useVendorOrder(orderId);
  const act = useOrderAction();
  const insets = useSafeAreaInsets();
  const pulse = useSharedValue(1);

  // The buzz loop lives exactly as long as the takeover does — and the bell
  // pulses on the same beat, so the sound has a visual twin.
  useEffect(() => {
    if (!orderId) return;
    const beat = () => {
      Vibration.vibrate([0, 400, 200, 400]);
      pulse.value = withSequence(
        withTiming(1.12, { duration: motion.duration.fast }),
        withTiming(1, { duration: motion.duration.base }),
        withTiming(1.12, { duration: motion.duration.fast }),
        withTiming(1, { duration: motion.duration.base }),
      );
    };
    beat();
    const timer = setInterval(beat, 5000);
    return () => {
      clearInterval(timer);
      Vibration.cancel();
    };
  }, [orderId, pulse]);

  const bellStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

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
    <Modal visible animationType="fade" onRequestClose={() => onDismiss(current.orderId)}>
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, padding: space['2xl'], paddingTop: insets.top + space['2xl'], paddingBottom: insets.bottom + space.md }}>
        <View style={{ alignItems: 'center' }}>
          <Animated.View
            style={[
              {
                width: 72,
                height: 72,
                borderRadius: radius.lg,
                backgroundColor: color.brand[50],
                alignItems: 'center',
                justifyContent: 'center',
              },
              bellStyle,
            ]}
          >
            <Feather name="bell" size={34} color={color.brand[500]} />
          </Animated.View>
          <T variant="micro" tone="brand" style={{ marginTop: space.lg }}>
            {queue.length > 1 ? `${queue.length} new orders — first in first` : 'New order'}
          </T>
          <T variant="displayXl" center style={{ marginTop: 2 }}>
            #{o?.orderNumber ?? current.orderNumber ?? '…'}
          </T>
          <T variant="heading" tone="muted" center style={{ marginTop: 2 }}>
            {[
              customer || null,
              `${items.length} item${items.length === 1 ? '' : 's'}`,
              o?.fulfillment === 'PICKUP' ? 'pickup' : 'delivery',
            ]
              .filter(Boolean)
              .join(' · ')}
          </T>
        </View>

        {/* Items — glanceable from across a kitchen. */}
        <ScrollView style={{ flex: 1, marginTop: space.xl }} contentContainerStyle={{ gap: space.sm }}>
          {items.map((i) => (
            <View key={i.id} style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
              <T variant="numM">{i.quantity}×</T>
              <T variant="heading" style={{ flex: 1 }} numberOfLines={2}>
                {i.name}
              </T>
            </View>
          ))}
        </ScrollView>

        {o?.totalAmount != null ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.lg, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
            <T variant="bodyStrong">Total</T>
            <Money amount={Number(o.totalAmount)} size="l" />
          </View>
        ) : null}

        <View style={{ gap: space.md }}>
          <PillButton
            label="Accept"
            size="xl"
            loading={busy}
            onPress={() => {
              haptic.commit();
              decide('accept');
            }}
          />
          <PillButton label="Decline" variant="soft" disabled={busy} onPress={() => decide('reject')} />
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
          style={{ marginTop: space.md, marginBottom: space.lg, textDecorationLine: 'underline' }}
          onPress={() => onDismiss(current.orderId)}
        >
          View later — the order stays on your board
        </T>
      </View>
    </Modal>
  );
}
