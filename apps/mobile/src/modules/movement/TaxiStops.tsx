/** @jsxImportSource react */
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, Eyebrow, StatePill, T } from '../../kit';
import { money } from '../../lib/money';
import { legLine, rideStops, stopPhase, type RideStop, type StopPhase, type StopPlace } from '../../lib/taxiItinerary';
import { clockLabel, stopWaitMinutes, type WaitingView } from '../../lib/taxiWaiting';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 6] The rider's stops: the rows the passenger edits on
// the booking card, the quoted route's legs, the stops of the live ride, and —
// [TAXI waiting charge] — the live wait. Every piece here renders ONLY when the
// server's answer calls for it, so a ride without stops (and a server without
// the waiting fields) draws exactly today's screen.
// ---------------------------------------------------------------------------

/** The numbered stop mark — on the route card, the itinerary and the map. */
export function StopNumber({ n, size = space.xl }: { n: number; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color.surface.base,
        borderWidth: 2,
        borderColor: color.text.primary,
      }}
    >
      <T variant="micro" weight="bold" accessible={false}>
        {n}
      </T>
    </View>
  );
}

function RowConnector() {
  return <View style={{ marginLeft: space.md, height: space.lg, width: space.xs / 2, backgroundColor: color.border.subtle, marginVertical: space.xs }} />;
}

function IconButton({ icon, label, onPress, testID }: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={space.xs}
      style={{ width: space['4xl'], height: space['4xl'], alignItems: 'center', justifyContent: 'center' }}
    >
      {({ pressed }) => <Feather name={icon} size={18} color={pressed ? color.text.primary : color.text.secondary} />}
    </Pressable>
  );
}

/**
 * The stops between the pickup and the destination on the booking card, in
 * the passenger's order. Each row opens the place search to change it, and
 * carries its own move-up / move-down (only when there is more than one stop)
 * and remove controls — separate touch targets with their own labels.
 */
export function StopRows({
  stops,
  onEdit,
  onMove,
  onRemove,
}: {
  stops: readonly StopPlace[];
  onEdit: (index: number) => void;
  onMove: (index: number, by: -1 | 1) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <>
      {stops.map((stop, i) => {
        const n = i + 1;
        return (
          <React.Fragment key={`${n}:${stop.lat},${stop.lng}`}>
            <View testID={`taxi-stop-${n}`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: space['5xl'] }}>
              <Pressable
                onPress={() => onEdit(i)}
                accessibilityRole="button"
                accessibilityLabel={`Stop ${n} of ${stops.length}. ${stop.label}`}
                accessibilityHint="Opens location search to change this stop"
                style={{ flex: 1, minHeight: space['5xl'], justifyContent: 'center' }}
              >
                {({ pressed }) => (
                  <View style={{ flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
                    <View style={{ width: space['2xl'], alignItems: 'center' }}>
                      <StopNumber n={n} />
                    </View>
                    <View style={{ flex: 1, marginLeft: space.sm }}>
                      <T variant="caption" tone="muted">Stop {n}</T>
                      <T variant="body" weight="semibold" numberOfLines={1}>{stop.label}</T>
                    </View>
                  </View>
                )}
              </Pressable>
              {stops.length > 1 && i > 0 ? (
                <IconButton icon="arrow-up" label={`Move stop ${n} up`} onPress={() => onMove(i, -1)} testID={`taxi-stop-up-${n}`} />
              ) : null}
              {stops.length > 1 && i < stops.length - 1 ? (
                <IconButton icon="arrow-down" label={`Move stop ${n} down`} onPress={() => onMove(i, 1)} testID={`taxi-stop-down-${n}`} />
              ) : null}
              <IconButton icon="x" label={`Remove stop ${n}`} onPress={() => onRemove(i)} testID={`taxi-stop-remove-${n}`} />
            </View>
            <RowConnector />
          </React.Fragment>
        );
      })}
    </>
  );
}

/** "+ Add a stop", while the server's max allows one more; at the max the
 *  control is gone and the limit is said plainly instead. */
export function AddStopRow({ canAdd, maxStops, onAdd }: { canAdd: boolean; maxStops: number; onAdd: () => void }) {
  return (
    <View style={{ marginTop: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border.subtle }}>
      {canAdd ? (
        <Pressable
          onPress={onAdd}
          testID="taxi-add-stop"
          accessibilityRole="button"
          accessibilityLabel="Add a stop"
          accessibilityHint="Opens location search to add a stop before your destination"
          style={{ minHeight: space['5xl'], justifyContent: 'center' }}
        >
          {({ pressed }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
              <View style={{ width: space['2xl'], alignItems: 'center' }}>
                <Feather name="plus" size={18} color={color.brand[600]} />
              </View>
              <T variant="body" weight="semibold" tone="deep" style={{ marginLeft: space.sm }}>
                Add a stop
              </T>
            </View>
          )}
        </Pressable>
      ) : (
        <T variant="caption" tone="muted" testID="taxi-stops-full" style={{ paddingVertical: space.sm }}>
          {maxStops === 1 ? 'You can add 1 stop.' : `You can add up to ${maxStops} stops.`}
        </T>
      )}
    </View>
  );
}

/** The fare line under the ride options when the trip has stops: ONE fare for
 *  the whole trip, said before the passenger confirms — no per-stop fee. */
export function oneFareLine(stopCount: number): string {
  return `One fare for the whole trip with ${stopCount === 1 ? '1 stop' : `${stopCount} stops`} · cash to the driver. No extra fee for stops.`;
}

/** The quoted route, leg by leg (the estimate's `legs`, in route order). */
export function RouteLegs({ legs }: { legs: unknown }) {
  const lines = Array.isArray(legs) ? legs.map(legLine).filter((l): l is string => !!l) : [];
  if (lines.length === 0) return null;
  return (
    <View testID="taxi-route-legs" style={{ marginTop: space.md, gap: space.xs }}>
      <Eyebrow>Your route</Eyebrow>
      {lines.map((line, i) => (
        <T key={`${i}:${line}`} variant="caption" tone="muted">
          {line}
        </T>
      ))}
    </View>
  );
}

const RIDER_PHASE: Record<StopPhase, { word: string; tone: 'neutral' | 'brand' | 'success' | 'warning' }> = {
  upcoming: { word: 'Coming up', tone: 'neutral' },
  next: { word: 'Next stop', tone: 'brand' },
  arrived: { word: 'Driver is at this stop', tone: 'brand' },
  done: { word: 'Done', tone: 'success' },
  skipped: { word: 'Skipped', tone: 'warning' },
};

/**
 * The live ride's stops, in order, each with its status in words (§5): coming
 * up, next, the driver is there, done, or skipped (with the driver's reason).
 * Drawn only for a ride that has stops; a ride without them shows nothing new.
 */
export function RideItinerary({ ride }: { ride: unknown }) {
  const stops = rideStops(ride);
  if (stops.length === 0) return null;
  const r = ride as { pickupAddress?: string | null; taxiDropoffAddress?: string | null; deliveryAddress?: string | null; status?: string };
  const destination = r.taxiDropoffAddress ?? r.deliveryAddress ?? 'Your destination';
  const next = stops.find((s) => stopPhase(s, ride) === 'next' || stopPhase(s, ride) === 'arrived');
  const underway = String(r.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';
  return (
    <Card testID="taxi-itinerary" style={{ marginTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md }}>
        <Eyebrow accessibilityRole="header">Your stops</Eyebrow>
        <T variant="caption" tone="muted">One fare for the whole trip</T>
      </View>
      {underway ? (
        <T variant="body" weight="semibold" style={{ marginTop: space.sm }}>
          {next ? `Next: stop ${next.sequence}, ${next.address}` : `Next: your destination, ${destination}`}
        </T>
      ) : null}
      <View style={{ marginTop: space.md, gap: space.sm }}>
        <ItineraryLine label="Pickup" address={r.pickupAddress ?? 'Pickup'} />
        {stops.map((stop) => (
          <RiderStopLine key={stop.sequence} stop={stop} phase={stopPhase(stop, ride)} count={stops.length} />
        ))}
        <ItineraryLine label="Destination" address={destination} />
      </View>
    </Card>
  );
}

function ItineraryLine({ label, address }: { label: string; address: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${address}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={{ width: space.xl, alignItems: 'center' }}>
        <Feather name={label === 'Pickup' ? 'circle' : 'map-pin'} size={14} color={label === 'Pickup' ? color.text.primary : color.brand[500]} />
      </View>
      <View style={{ flex: 1 }}>
        <T variant="caption" tone="muted">{label}</T>
        <T variant="label" weight="semibold" numberOfLines={1}>{address}</T>
      </View>
    </View>
  );
}

function RiderStopLine({ stop, phase, count }: { stop: RideStop; phase: StopPhase; count: number }) {
  const meta = RIDER_PHASE[phase];
  const waited = stopWaitMinutes(stop);
  const extra = [
    phase === 'skipped' && stop.skipReason ? `Driver’s note: ${stop.skipReason}` : null,
    waited != null ? `Waited ${waited} min` : null,
  ].filter(Boolean).join(' · ');
  return (
    <View
      testID={`taxi-itinerary-stop-${stop.sequence}`}
      accessible
      accessibilityLabel={`Stop ${stop.sequence} of ${count}: ${stop.address}. ${meta.word}.${extra ? ` ${extra}.` : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
    >
      <View style={{ width: space.xl, alignItems: 'center' }}>
        <StopNumber n={stop.sequence} size={space.lg + space.xs} />
      </View>
      <View style={{ flex: 1 }}>
        <T variant="label" weight="semibold" numberOfLines={1}>{stop.address}</T>
        {extra ? <T variant="caption" tone="muted" numberOfLines={2}>{extra}</T> : null}
      </View>
      <StatePill label={meta.word} tone={meta.tone} />
    </View>
  );
}

/**
 * [TAXI waiting charge · §8.3] The live wait, once the driver has arrived: the
 * minutes waited (ticking while a wait runs), the charge so far — always the
 * server's figure — and, while waiting, when the next charge lands. Drawn only
 * when the server sends the `waiting` object.
 */
export function WaitingCard({ view, pickupWaitMinutes }: { view: WaitingView; pickupWaitMinutes: number | null }) {
  const block = `${money(view.chargePerBlock)} per ${view.blockMinutes} minutes`;
  const chargeText = view.charge > 0 ? `${money(view.charge)} so far` : 'No charge yet';
  return (
    <Card testID="taxi-waiting" style={{ marginTop: space.md }}>
      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={`Waiting time ${view.minutes} minutes. Waiting charge ${chargeText}.${view.nextChargeInSeconds != null ? ` Next ${money(view.chargePerBlock)} in ${clockLabel(view.nextChargeInSeconds)}.` : ''}`}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md }}>
          <Eyebrow>{view.running ? 'Waiting now' : 'Waiting'}</Eyebrow>
          <T variant="caption" tone="muted">{block}</T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md, marginTop: space.xs }}>
          <T variant="body" weight="semibold">{view.minutes} min waited</T>
          <T variant="body" weight="semibold">{chargeText}</T>
        </View>
        {view.nextChargeInSeconds != null ? (
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            Next {money(view.chargePerBlock)} in {clockLabel(view.nextChargeInSeconds)}
          </T>
        ) : null}
        {pickupWaitMinutes != null ? (
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            At the pickup: {pickupWaitMinutes} min
          </T>
        ) : null}
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Paid in cash with your fare at the end.
        </T>
      </View>
    </Card>
  );
}
