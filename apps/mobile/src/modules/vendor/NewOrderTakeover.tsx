import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
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
  const [rejecting, setRejecting] = useState(false);
  // A fresh order in the queue starts at the decision, never mid-reject.
  useEffect(() => setRejecting(false), [orderId]);
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
      // [design-100x Flow-13] The VIBRATION alarm stays on its beat — a missed
      // order is money, and a kitchen bell is functional alerting. The VISUAL
      // pulse honours Reduce Motion (the screen stays still; the buzz carries).
      pulse.value = withSequence(
        withTiming(1.12, { duration: motion.duration.fast, reduceMotion: ReduceMotion.System }),
        withTiming(1, { duration: motion.duration.base, reduceMotion: ReduceMotion.System }),
        withTiming(1.12, { duration: motion.duration.fast, reduceMotion: ReduceMotion.System }),
        withTiming(1, { duration: motion.duration.base, reduceMotion: ReduceMotion.System }),
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

  const decide = (action: 'accept' | 'reject', reason?: string) =>
    act.mutate(
      { id: current.orderId, action, ...(reason ? { reason } : {}) },
      { onSuccess: () => onDismiss(current.orderId) },
    );

  return (
    <Modal
      visible
      animationType="fade"
      // Android hardware back is INERT here. Leaving this order is a decision —
      // Accept, Reject, or the explicit "View later" below — and a reflex press
      // must not be indistinguishable from one. The server's escalation ladder
      // still stands behind a dismissal either way; this is about the vendor
      // knowing which of the three they chose.
      onRequestClose={() => {}}
    >
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
          {/* [Wave 3 vs reference 22] The eyebrow tells the vendor what the
              sound will DO — the buzz genuinely repeats every 5s below, so
              "chime repeats until you answer" is a promise this screen keeps. */}
          <T variant="micro" tone="brand" style={{ marginTop: space.lg }}>
            {queue.length > 1
              ? `● ${queue.length} new orders · chime repeats — first in, first`
              : '● New order · chime repeats until you answer'}
          </T>
          <T variant="displayXl" center style={{ marginTop: 2 }}>
            #{o?.orderNumber ?? current.orderNumber ?? '…'}
          </T>
          <T variant="heading" tone="muted" center style={{ marginTop: 2 }}>
            {/* [Wave 3 vs reference 22] The fulfillment says what happens
                NEXT, not just which kind it is — "a rider comes to you" is
                the sentence a kitchen acts on. */}
            {[
              customer || null,
              `${items.length} item${items.length === 1 ? '' : 's'}`,
              o?.fulfillment === 'PICKUP' ? 'pickup — the customer comes to you' : 'delivery — a rider comes to you',
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
              {/* [Wave 3 vs reference 22] "pepper on the side" · "cold" — the
                  customer's own words, right-aligned and muted, exactly where
                  the kitchen's eye lands after the dish. The snapshot column
                  (OrderItem.specialInstructions) already rides the payload. */}
              {i.specialInstructions ? (
                <T variant="label" tone="muted" numberOfLines={2} style={{ maxWidth: '38%', textAlign: 'right' }}>
                  {i.specialInstructions}
                </T>
              ) : null}
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
            // [Wave 3 vs reference 22] "ACCEPT ORDER", sized to be read across
            // a kitchen — the reference sets it in caps and says the thing.
            label="ACCEPT ORDER"
            size="xl"
            loading={busy}
            onPress={() => {
              haptic.commit();
              decide('accept');
            }}
          />
          {/* [Wave 3 vs reference 22] "A rejection always collects a reason."
              The route records it and the customer is told why — so the button
              says what it asks, and the choice is presets, never free typing
              in a rush. */}
          {rejecting ? (
            <>
              {(['Out of stock', 'Kitchen is too busy', 'Closing soon'] as const).map((why) => (
                <PillButton
                  key={why}
                  label={why}
                  variant="outline"
                  disabled={busy}
                  onPress={() => decide('reject', why)}
                />
              ))}
              <PillButton label="Back" variant="soft" disabled={busy} onPress={() => setRejecting(false)} />
            </>
          ) : (
            <PillButton label="Reject — tell us why" variant="soft" disabled={busy} onPress={() => setRejecting(true)} />
          )}
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
