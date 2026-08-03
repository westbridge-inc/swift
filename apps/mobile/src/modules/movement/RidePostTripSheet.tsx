/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { color, radius, space } from '@swift/ui';
import { money } from '../../lib/money';
import { useRateOrder, useTipOrder } from '../../hooks/customer';
import { IconChip, PillButton, PopupCard, Stars, T } from '../../kit';

/** Round a suggested tip to a cash-friendly amount (nearest 100, min 100). */
const roundCash = (n: number) => Math.max(100, Math.round(n / 100) * 100);

/**
 * Post-trip closure for a completed ride: rate the driver + (optionally) add a
 * CASH tip. Rides are cash — a tip is recorded so the driver gets credit for it
 * and 100% is theirs; it's handed over in person, not processed in-app. Reuses
 * the same /rate + /tip endpoints as delivery orders (a taxi is an order).
 */
export function RidePostTripSheet({ ride, onDone }: { ride: any | null; onDone: () => void }) {
  const rate = useRateOrder(ride?.id ?? '');
  const tip = useTipOrder(ride?.id ?? '');
  const [score, setScore] = useState(0);
  const [tipAmt, setTipAmt] = useState<number | null>(null);

  // Reset when a new ride completes (the sheet is reused across rides).
  useEffect(() => {
    setScore(0);
    setTipAmt(null);
  }, [ride?.id]);

  if (!ride) return null;

  const fare = Number(ride.taxiFareTotal ?? ride.totalAmount ?? 0);
  const driverName = ride.driver?.user?.firstName ?? 'your driver';
  const presets = Array.from(new Set([0.1, 0.15, 0.2].map((p) => roundCash(fare * p)))).filter((v) => v > 0);
  const busy = rate.isPending || tip.isPending;

  const submit = async () => {
    // Fire whichever the rider chose; a plain "Done" with nothing picked just
    // closes. Never block closing on a failed rating/tip — best-effort.
    try {
      if (score > 0) await rate.mutateAsync({ driverScore: score });
      if (tipAmt && tipAmt > 0) await tip.mutateAsync(tipAmt);
    } catch {
      // swallow — the ride is already over; don't trap the rider in the sheet
    }
    onDone();
  };

  const when = ride.deliveredAt ?? ride.placedAt;
  const rideClassLabel =
    ride.rideClass ? String(ride.rideClass).charAt(0) + String(ride.rideClass).slice(1).toLowerCase() : null;

  return (
    <PopupCard visible={!!ride} onClose={onDone}>
      <IconChip icon="check-circle" size={56} />
      <T variant="title" center style={{ marginTop: space.lg }}>
        Trip complete
      </T>
      <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
        {money(fare)} · cash · paid to {driverName}
      </T>

      {ride.driver?.mmgPayUrl ? (
        // 5.9 MMG path [rides spec]: the DRIVER'S OWN pay link — money goes
        // straight to them, Swift never holds it. No cash on you → one tap.
        // Honesty law: opening the link never fakes a "Paid ✓"; the driver
        // confirms receipt on their side like any MMG transfer.
        <>
          <PillButton
            label={`Pay ${money(fare)} with MMG instead`}
            variant="outline"
            style={{ marginTop: space.md, alignSelf: 'stretch' }}
            onPress={() => WebBrowser.openBrowserAsync(String(ride.driver.mmgPayUrl)).catch(() => undefined)}
          />
          <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
            Goes straight to {driverName} on their MMG — show them the confirmation.
          </T>
        </>
      ) : null}

      {/* Receipt — the trip on paper: route, when, class + fare. */}
      <View style={{ alignSelf: 'stretch', borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md, marginTop: space.lg }}>
        {ride.pickupAddress ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: color.text.muted }} />
            <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {ride.pickupAddress}
            </T>
          </View>
        ) : null}
        {ride.deliveryAddress ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6 }}>
            <View style={{ width: 9, alignItems: 'center' }}>
              <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: color.brand[500] }} />
            </View>
            <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {ride.deliveryAddress}
            </T>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
          <T variant="caption" tone="muted">
            {[rideClassLabel, when ? new Date(when).toLocaleString() : null].filter(Boolean).join(' · ')}
          </T>
          <T variant="caption" weight="bold">
            {money(fare)}
          </T>
        </View>
      </View>

      <T variant="body" weight="semibold" center style={{ marginTop: space['2xl'] }}>
        How was your ride?
      </T>
      <View style={{ alignItems: 'center', marginTop: space.md }}>
        <Stars value={score} size={38} gap={10} onRate={setScore} />
      </View>

      {presets.length ? (
        <>
          <T variant="label" tone="muted" center style={{ marginTop: space['2xl'] }}>
            Add a cash tip for {driverName}? 100% theirs — hand it over at drop-off.
          </T>
          <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
            {presets.map((v) => {
              const active = tipAmt === v;
              return (
                <Pressable key={v} onPress={() => setTipAmt(active ? null : v)}>
                  <View
                    style={{
                      paddingHorizontal: space.lg,
                      paddingVertical: space.sm,
                      borderRadius: radius.full,
                      borderWidth: 1.5,
                      borderColor: active ? color.brand[500] : color.border.strong,
                      backgroundColor: active ? color.brand[50] : color.surface.base,
                    }}
                  >
                    <T variant="label" weight="semibold" tone={active ? 'brand' : 'ink'}>
                      {money(v)}
                    </T>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      <PillButton
        label={tipAmt ? `Submit · ${money(tipAmt)} tip` : 'Submit'}
        style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
        loading={busy}
        onPress={submit}
      />
      <PillButton label="Skip" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} disabled={busy} onPress={onDone} />
    </PopupCard>
  );
}
