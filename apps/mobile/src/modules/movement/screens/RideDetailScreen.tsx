/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { Header, IconChip, LoadingBlock, ErrorState, PillButton, Screen, Stars, T } from '../../../kit';
import { useRateOrder } from '../../../hooks/customer';
import { money } from '../../../lib/money';
import { rideStops } from '../../../lib/taxiItinerary';
import { fareBreakdownOf } from '../../../lib/taxiWaiting';
import { rideCanBeRated, rideOverTitle, ridePaidAmount } from '../../../lib/rideAfterTrip';
import { rideApi } from '../../../services/api';

/**
 * [BUG-HUNT-2 G06] A ride that is over. The post-trip sheet shows only if the ride screen was open when the socket event landed,
 * so a passenger who pocketed the phone had no receipt, no driver, no rating and no way to report anything about the trip.
 * Reached from Orders, from every end-of-ride notice, and from any door that lands on a finished ride.
 */
export function RideDetailScreen({ navigation, route }: any) {
  const rideId: string = route.params?.rideId;
  const ride = useQuery({ queryKey: ['ride', 'detail', rideId], queryFn: () => rideApi.get(rideId).then((res) => res.data?.data), enabled: !!rideId });
  const rate = useRateOrder(rideId);
  const [score, setScore] = useState(0);
  const [rated, setRated] = useState(false);

  if (ride.isLoading) return <Screen><Header title="Your ride" /><LoadingBlock /></Screen>;
  if (ride.isError || !ride.data) return <Screen><Header title="Your ride" /><ErrorState onRetry={() => void ride.refetch()} /></Screen>;

  const r = ride.data;
  const breakdown = fareBreakdownOf(r);
  const paid = ridePaidAmount(r);
  const stops = rideStops(r);
  const driverName: string | null = r.driver?.user?.firstName ?? null;
  const vehicle = [r.driver?.vehicleColor, r.driver?.vehicleMake, r.driver?.vehicleModel].filter(Boolean).join(' ');
  const line = (label: string, text: string | null | undefined) => (text ? (
    <View style={{ marginTop: space.sm }}>
      <T variant="caption" tone="muted">{label}</T>
      <T variant="body">{text}</T>
    </View>
  ) : null);

  return (
    <Screen>
      <Header title="Your ride" />
      <ScrollView contentContainerStyle={{ padding: space.lg }}>
        <IconChip icon="check-circle" size={56} />
        <T variant="title" accessibilityRole="header" style={{ marginTop: space.md }}>{rideOverTitle(r.status)}</T>
        {r.cancellationReason ? <T variant="body" tone="muted" style={{ marginTop: space.xs }}>{r.cancellationReason}</T> : null}
        <View style={{ borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md, marginTop: space.lg }}>
          {line('Order', r.orderNumber)}
          {line('Driver', driverName)}
          {line('Car', [vehicle, r.driver?.licensePlate].filter(Boolean).join(' · '))}
          {line('From', r.pickupAddress)}
          {stops.map((stop: { sequence: number; address: string }) => <React.Fragment key={stop.sequence}>{line(`Stop ${stop.sequence}`, stop.address)}</React.Fragment>)}
          {line('To', r.deliveryAddress)}
          {breakdown ? (
            <>
              {line('Trip', money(breakdown.routeFare))}
              {line(`Waiting (${breakdown.waitingMinutes} min)`, money(breakdown.waitingCharge))}
            </>
          ) : null}
          {paid !== null && !['CANCELLED', 'FAILED'].includes(String(r.status)) ? line('Total', money(paid)) : null}
        </View>
        {rideCanBeRated(r) && !rated ? (
          <View style={{ alignItems: 'center', marginTop: space.lg }}>
            <T variant="body" weight="semibold">Rate your ride{driverName ? ` with ${driverName}` : ''}</T>
            <Stars value={score} size={38} gap={10} onRate={setScore} />
            <PillButton
              label="Send rating"
              variant="primary"
              style={{ alignSelf: 'stretch', marginTop: space.md }}
              disabled={score <= 0 || rate.isPending}
              loading={rate.isPending}
              onPress={() => rate.mutate({ driverScore: score }, { onSuccess: () => setRated(true) })}
            />
          </View>
        ) : null}
        <PillButton
          label="Get help with this ride"
          variant="outline"
          style={{ alignSelf: 'stretch', marginTop: space.lg }}
          onPress={() => navigation.navigate('GetHelp', { orderId: r.id, subject: `Ride ${r.orderNumber}` })}
        />
        <PillButton label="Book a taxi" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => navigation.navigate('Taxi')} />
      </ScrollView>
    </Screen>
  );
}
