/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { money } from '../../lib/money';
import { useRateOrder } from '../../hooks/customer';
import { IconChip, PillButton, PopupCard, PopupTitle, Stars, T } from '../../kit';
import {
  AuthSessionBoundaryError,
  requireAuthSessionSnapshot,
} from '../../stores/authStore';
import { openPayLink, safePayUrl } from '../../lib/payLink';
import { ContentSafetyActions } from '../../components/moderation/ContentSafetyActions';

/**
 * Post-trip closure for a completed ride: rate the driver. Tipping is CASH in
 * person — [WR-009] the in-app tip recorder was removed because the server
 * fails post-delivery tips closed (LB-015: no rail collects them; recording
 * one minted an earning from money nobody collected). The sheet keeps the
 * cash-tip suggestion as guidance only; checkout-time tips are untouched.
 */
export function RidePostTripSheet({ ride, onDone }: { ride: any | null; onDone: () => void }) {
  const rate = useRateOrder(ride?.id ?? '');
  const [score, setScore] = useState(0);
  const [locallyBlocked, setLocallyBlocked] = useState(false);

  // Reset when a new ride completes (the sheet is reused across rides).
  useEffect(() => {
    setScore(0);
    setLocallyBlocked(false);
  }, [ride?.id]);

  if (!ride) return null;

  const fare = Number(ride.taxiFareTotal ?? ride.totalAmount ?? 0);
  const driverProfileHidden = locallyBlocked || ride.driver?.contactBlocked === true;
  const driverName = driverProfileHidden ? 'your driver' : ride.driver?.user?.firstName ?? 'your driver';
  // Validated once, here — the button only exists if the destination passes.
  const driverPayUrl = driverProfileHidden ? null : safePayUrl(ride.driver?.mmgPayUrl);
  const busy = rate.isPending;

  const submit = async () => {
    // A plain "Done" with nothing picked just closes. Never block closing on
    // a failed rating — best-effort.
    if (score <= 0) {
      onDone();
      return;
    }
    try {
      const owner = requireAuthSessionSnapshot();
      await rate.mutateAsync({ driverScore: score, authSession: owner });
    } catch (submitError) {
      if (submitError instanceof AuthSessionBoundaryError) return;
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
      <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
        Trip complete
      </PopupTitle>
      <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
        {money(fare)} · cash · paid to {driverName}
      </T>
      {ride.driver?.userId ? (
        <ContentSafetyActions
          targetType="USER"
          targetId={ride.driver.userId}
          contentLabel="driver profile"
          allowBlock={!driverProfileHidden}
          onBlocked={() => setLocallyBlocked(true)}
          style={{ alignSelf: 'center', marginTop: space.md }}
        />
      ) : null}

      {driverPayUrl ? (
        // 5.9 MMG path [rides spec]: the DRIVER'S OWN pay link — money goes
        // straight to them, Swift never holds it. No cash on you → one tap.
        // Honesty law: opening the link never fakes a "Paid ✓"; the driver
        // confirms receipt on their side like any MMG transfer.
        //
        // The URL is validated by the SAME check every other money link in the
        // app passes (safePayUrl): https only, no embedded credentials, no
        // fragment, port 443, a real public hostname, never an IP literal.
        // This one path used to open `ride.driver.mmgPayUrl` raw — the single
        // place a customer could be sent to an unvalidated destination while
        // holding their wallet. A link that fails the check simply does not
        // render, so the sheet falls back to cash rather than offering a
        // payment button that cannot be trusted.
        <>
          <PillButton
            label={`Pay ${money(fare)} with MMG instead`}
            variant="outline"
            style={{ marginTop: space.md, alignSelf: 'stretch' }}
            onPress={() => { void openPayLink(driverPayUrl); }}
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

      <View
        style={{
          marginTop: space['2xl'],
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          borderRadius: radius.lg,
          backgroundColor: color.brand[50],
        }}
      >
        <T variant="label" tone="muted" center>
          Want to tip {driverName}? Cash at drop-off — 100% theirs, straight to their hand.
        </T>
      </View>

      <PillButton
        label="Submit"
        style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
        loading={busy}
        onPress={submit}
      />
      <PillButton label="Skip" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} disabled={busy} onPress={onDone} />
    </PopupCard>
  );
}
