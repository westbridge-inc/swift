/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { radius, space } from '@swift/ui';
import { PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { toast } from '../../kit/toast';
import { useTaxiStopAction } from '../../hooks/mover';
import { money } from '../../lib/money';
import { openExternal } from '../../lib/openExternal';
import {
  driverStopStep,
  nextStopSequence,
  rideStops,
  stopActionsSupported,
  stopNavigationUrls,
  stopPhase,
  type RideStop,
  type StopPhase,
} from '../../lib/taxiItinerary';
import { clockLabel, stopWaitMinutes, type WaitingView } from '../../lib/taxiWaiting';
import { DCard, dk, withAlpha } from './surface';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · part 7] The driver's stops: "N stops" on the live offer
// and the board, the trip's stops in order on the active trip — the current
// one highlighted, each with Navigate to the phone's own maps — and the part-4
// stop actions, offered only when the server shows it has them. [TAXI waiting
// charge] The same live wait the passenger sees. All of it renders only when
// the server's answer carries stops (or `waiting`); a ride without stops draws
// exactly today's screens.
// ---------------------------------------------------------------------------

/** Open the phone's own maps, turn-by-turn, at one point: Apple Maps on iOS,
 *  Google Maps on Android, the web map if the app link cannot open. */
export async function openStopNavigation(point: { lat: number; lng: number }): Promise<void> {
  const { app, web } = stopNavigationUrls(point, Platform.OS);
  try {
    await Linking.openURL(app);
  } catch {
    await openExternal(web, "Couldn't open maps on this phone.");
  }
}

/** "2 stops · one fare for the whole trip" — on the offer and the board. */
export function StopsSummary({ count, testID }: { count: number; testID?: string }) {
  if (count <= 0) return null;
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm }}>
      <Feather name="git-commit" size={13} color={dk.accent} />
      <T variant="caption" weight="semibold" style={{ color: dk.text }}>
        {count === 1 ? '1 stop' : `${count} stops`} · one fare for the whole trip
      </T>
    </View>
  );
}

const DRIVER_PHASE: Record<StopPhase, string> = {
  upcoming: 'Later',
  next: 'Next',
  arrived: 'You’re here',
  done: 'Done',
  skipped: 'Skipped',
};

type Place = { key: string; title: string; address: string; point: { lat: number; lng: number } | null; status: string | null; current: boolean; note: string | null; navLabel: string; testID: string };

const pointOf = (lat: unknown, lng: unknown) => {
  const la = Number(lat);
  const ln = Number(lng);
  return lat != null && lng != null && Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 ? { lat: la, lng: ln } : null;
};

/**
 * The active trip's places in order: pickup, each stop, the final drop-off.
 * The place the driver is heading for is highlighted — the pickup before the
 * trip starts, then the server's next stop, then the drop-off — and every stop
 * and the drop-off carry their own Navigate.
 */
export function DriverItinerary({ job }: { job: any }) {
  const stops = rideStops(job);
  if (stops.length === 0) return null;
  const underway = String(job?.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';
  const next = nextStopSequence(job);
  const places: Place[] = [
    {
      key: 'pickup', title: 'Pickup', address: job?.pickupAddress ?? 'Pickup', point: pointOf(job?.pickupLat, job?.pickupLng),
      status: underway ? 'Done' : null, current: !underway, note: null, navLabel: 'Navigate to the pickup', testID: 'driver-itinerary-pickup',
    },
    ...stops.map((stop: RideStop): Place => {
      const phase = stopPhase(stop, job);
      const waited = stopWaitMinutes(stop);
      return {
        key: `stop-${stop.sequence}`,
        title: `Stop ${stop.sequence}`,
        address: stop.address,
        point: stop.lat != null && stop.lng != null ? { lat: stop.lat, lng: stop.lng } : null,
        status: DRIVER_PHASE[phase],
        current: underway && stop.sequence === next,
        note: [phase === 'skipped' && stop.skipReason ? stop.skipReason : null, waited != null ? `Waited ${waited} min` : null].filter(Boolean).join(' · ') || null,
        navLabel: `Navigate to stop ${stop.sequence}, ${stop.address}`,
        testID: `driver-itinerary-stop-${stop.sequence}`,
      };
    }),
    {
      key: 'dropoff', title: 'Drop-off', address: job?.taxiDropoffAddress ?? job?.deliveryAddress ?? job?.dropoffAddress ?? 'Drop-off',
      point: pointOf(job?.deliveryLat, job?.deliveryLng), status: null, current: underway && next == null, note: null,
      navLabel: 'Navigate to the drop-off', testID: 'driver-itinerary-dropoff',
    },
  ];
  return (
    <View testID="driver-itinerary" style={{ gap: space.sm }}>
      <T variant="caption" weight="bold" style={{ color: dk.muted, letterSpacing: 1 }}>
        {`${stops.length === 1 ? '1 STOP' : `${stops.length} STOPS`} · ONE FARE FOR THE WHOLE TRIP`}
      </T>
      {places.map((place) => (
        <View
          key={place.key}
          testID={place.testID}
          accessibilityState={{ selected: place.current }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            borderRadius: radius.md,
            borderWidth: place.current ? 2 : 1,
            borderColor: place.current ? dk.accent : dk.line,
            backgroundColor: place.current ? dk.cardSoft : dk.card,
            paddingVertical: space.sm,
            paddingLeft: space.md,
            paddingRight: space.xs,
          }}
        >
          <View
            accessible
            accessibilityLabel={`${place.title}: ${place.address}.${place.current ? ' Heading here now.' : ''}${place.status ? ` ${place.status}.` : ''}${place.note ? ` ${place.note}.` : ''}`}
            style={{ flex: 1 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <T variant="caption" weight="bold" style={{ color: place.current ? dk.accent : dk.muted, letterSpacing: 1 }}>
                {place.current ? `${place.title.toUpperCase()} · NOW` : place.title.toUpperCase()}
              </T>
              {place.status && !place.current ? (
                <T variant="caption" weight="semibold" style={{ color: dk.muted }}>{place.status}</T>
              ) : null}
            </View>
            <T variant="label" weight="semibold" numberOfLines={1} style={{ color: dk.text, marginTop: 2 }}>
              {place.address}
            </T>
            {place.note ? (
              <T variant="caption" numberOfLines={2} style={{ color: dk.muted, marginTop: 2 }}>{place.note}</T>
            ) : null}
          </View>
          {place.point && place.key !== 'pickup' ? (
            <Pressable
              onPress={() => void openStopNavigation(place.point!)}
              testID={`driver-navigate-${place.key}`}
              accessibilityRole="link"
              accessibilityLabel={place.navLabel}
              accessibilityHint="Opens turn-by-turn directions in your maps app"
              hitSlop={space.xs}
              style={{ minHeight: space['4xl'], paddingHorizontal: space.md, justifyContent: 'center' }}
            >
              {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, opacity: pressed ? 0.7 : 1 }}>
                  <Feather name="navigation" size={14} color={dk.accent} />
                  <T variant="label" weight="semibold" style={{ color: dk.accent }}>Navigate</T>
                </View>
              )}
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * [TAXI multi-stop · part 4] While a stop is open, "the passenger didn't come
 * back" belongs to the server's grace (CONTRACT §6.4: no_show at an arrived
 * stop only after `noShowAvailableAt`). True only when the server's stopWait
 * is for the stop the trip is at and its time has passed; the screen re-renders
 * on the boundary. No stopWait (a part-3 server, or not waiting) = never.
 */
export function useNoShowOpen(job: any): boolean {
  const sequence = nextStopSequence(job);
  const wait = job?.stopWait as { sequence?: unknown; noShowAvailableAt?: unknown } | null | undefined;
  const at = wait && sequence != null && wait.sequence === sequence && typeof wait.noShowAvailableAt === 'string'
    ? Date.parse(wait.noShowAvailableAt)
    : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(at)) return;
    const ms = at - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), ms + 50);
    return () => clearTimeout(t);
  }, [at]);
  return Number.isFinite(at) && Date.now() >= at;
}

const SKIP_REASONS =['Passenger asked to skip it', 'Couldn’t reach the stop', 'Road or access blocked'] as const;

/**
 * The stop step while the passenger is aboard and a stop is still open. With
 * the part-4 server: "Arrived at stop N", then "Done at stop N", and "Skip
 * stop N" with a reason the passenger is told. Without it: the stops are
 * read-only, and because the server will not take the fare while a stop is
 * open, the fare button is held back and support is the way out.
 */
export function TaxiStopActions({ job, disabled, onGetHelp }: { job: any; disabled: boolean; onGetHelp: () => void }) {
  const act = useTaxiStopAction();
  const [skipOpen, setSkipOpen] = useState(false);
  const step = driverStopStep(job);
  if (!step) return null;
  const supported = stopActionsSupported(job);
  const failed = (e: any) => toast.show(e?.response?.data?.error?.message ?? 'Couldn’t update the stop — try again.');

  if (!supported) {
    return (
      <View testID="driver-stops-readonly" style={{ borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md }}>
        <T variant="caption" weight="semibold" style={{ color: dk.text }}>
          Stop {step.sequence} is next. The fare is collected after the last stop.
        </T>
        <T variant="caption" style={{ color: dk.muted, marginTop: space.xs }}>
          This trip’s stops can’t be marked from the app yet. Contact support to finish it.
        </T>
        <PillButton label="Contact support" variant="outline" size="md" style={{ marginTop: space.md }} onPress={onGetHelp} />
      </View>
    );
  }

  const stopWait = job?.stopWait as { sequence?: number; noShowAvailableAt?: string } | null | undefined;
  const graceAt = stopWait?.sequence === step.sequence && typeof stopWait?.noShowAvailableAt === 'string' ? new Date(stopWait.noShowAvailableAt) : null;
  return (
    <View testID="driver-stop-actions">
      {graceAt && Number.isFinite(graceAt.getTime()) ? (
        <T variant="caption" style={{ color: dk.muted, marginBottom: space.sm }}>
          Waiting at stop {step.sequence}. If the passenger doesn’t come back, you can end the trip from {graceAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
        </T>
      ) : null}
      <PillButton
        label={step.label}
        testID={`driver-stop-${step.action}-${step.sequence}`}
        loading={act.isPending}
        disabled={disabled || act.isPending}
        style={{ minHeight: 56 }}
        onPress={() => act.mutate({ id: job.id, sequence: step.sequence, action: step.action }, { onError: failed })}
      />
      <PillButton
        label={`Skip stop ${step.sequence}`}
        testID={`driver-stop-skip-${step.sequence}`}
        variant="soft"
        style={{ marginTop: space.sm }}
        disabled={disabled || act.isPending}
        onPress={() => setSkipOpen(true)}
      />
      <PopupCard visible={skipOpen} onClose={() => setSkipOpen(false)}>
        <PopupTitle variant="title" center>Skip stop {step.sequence}?</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          The passenger is told the stop was skipped and why. The fare stays the same. Pick what happened:
        </T>
        {SKIP_REASONS.map((why) => (
          <PillButton
            key={why}
            label={why}
            variant="outline"
            style={{ alignSelf: 'stretch', marginTop: space.md }}
            disabled={act.isPending}
            onPress={() => {
              setSkipOpen(false);
              act.mutate({ id: job.id, sequence: step.sequence, action: 'skip', reason: why }, { onError: failed });
            }}
          />
        ))}
        <PillButton label="Keep the stop" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => setSkipOpen(false)} />
      </PopupCard>
    </View>
  );
}

/**
 * [TAXI waiting charge §8.3] The live wait on the driver's trip — the same
 * figures the passenger sees: minutes waited (ticking while a wait runs), the
 * server's charge so far, and the trip fare beside it. The two amounts are
 * shown apart: the phone never adds money up.
 */
export function DriverWaiting({ view, tripFare }: { view: WaitingView; tripFare: number | null }) {
  const chargeText = view.charge > 0 ? `${money(view.charge)} so far` : 'No charge yet';
  return (
    <View testID="driver-waiting">
      <DCard style={{ marginBottom: space.md }}>
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Waiting time ${view.minutes} minutes. Waiting charge ${chargeText}.${view.nextChargeInSeconds != null ? ` Next ${money(view.chargePerBlock)} in ${clockLabel(view.nextChargeInSeconds)}.` : ''}`}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T variant="caption" weight="bold" style={{ color: dk.muted, letterSpacing: 1 }}>
              {view.running ? 'WAITING NOW' : 'WAITING'}
            </T>
            <T variant="caption" style={{ color: dk.muted }}>
              {money(view.chargePerBlock)} per {view.blockMinutes} min
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.xs }}>
            <T variant="body" weight="bold" style={{ color: dk.text }}>{view.minutes} min waited</T>
            <T variant="body" weight="bold" style={{ color: dk.text }}>{chargeText}</T>
          </View>
          {view.nextChargeInSeconds != null ? (
            <T variant="caption" style={{ color: dk.muted, marginTop: space.xs }}>
              Next {money(view.chargePerBlock)} in {clockLabel(view.nextChargeInSeconds)}
            </T>
          ) : null}
          {tripFare != null ? (
            <T variant="caption" weight="semibold" style={{ color: dk.text, marginTop: space.sm }}>
              Collect in cash: trip fare {money(tripFare)} and waiting {money(view.charge)}.
            </T>
          ) : null}
        </View>
      </DCard>
    </View>
  );
}
