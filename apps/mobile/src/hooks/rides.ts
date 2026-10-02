import { track } from '../lib/analytics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rideApi, type RideClass, type RideRequestBody, type TaxiStopInput, type TieredEstimate } from '../services/api';
import { customerKeys } from './customer';
import { rideRequestAttempt } from '../lib/rideRequestAttemptStore';
import { getAuthSessionSnapshot } from '../stores/authStore';

type Point = { lat: number; lng: number };

const errorCodeOf = (error: unknown): string | undefined =>
  (error as { response?: { data?: { error?: { code?: string } } } } | null)?.response?.data?.error?.code;

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useActiveRide<T = any>(poll = false) {
  return useQuery<T>({
    queryKey: ['rides', 'active'],
    queryFn: () => unwrap<T>(rideApi.active()),
    refetchInterval: poll ? 8000 : undefined,
  });
}

/** Tiered fares (Economy/Comfort/XL) for the request screen.
 *  [TAXI multi-stop] With stops the key carries them, so EVERY add, remove or
 *  reorder is a new quote, and the screen holds the request until it lands.
 *  Without stops the key and the body are exactly today's. */
export function useRideEstimate(pickup?: Point, dropoff?: Point, stops?: readonly TaxiStopInput[]) {
  const withStops = stops && stops.length > 0 ? stops : undefined;
  return useQuery<TieredEstimate>({
    queryKey: withStops ? ['rides', 'estimate', pickup, dropoff, withStops] : ['rides', 'estimate', pickup, dropoff],
    queryFn: () => unwrap<TieredEstimate>(rideApi.estimate(pickup as Point, dropoff as Point, withStops)),
    enabled: !!pickup && !!dropoff,
  });
}

/** [TAXI multi-stop] What this server takes: `{ maxStops }` (0 = no stops).
 *  An older server has no such read (404) — the query fails, there is no data,
 *  and the booking screen stays exactly today's. Never retried on a 4xx. */
export function useRideCapabilities() {
  return useQuery<{ maxStops?: number; waiting?: unknown }>({
    queryKey: ['rides', 'capabilities'],
    queryFn: () => unwrap(rideApi.capabilities()),
  });
}

/** Honest supply read for the request screen (availability spec §2.1):
 *  GOOD/LOW/NONE buckets from the same query dispatch searches. */
export function useRideAvailability(point?: Point) {
  return useQuery<{ level: 'GOOD' | 'LOW' | 'NONE'; nearestEtaMinutes: number | null; gate?: boolean }>({
    queryKey: ['rides', 'availability', point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : null],
    queryFn: () => unwrap(rideApi.availability(point as Point)),
    enabled: !!point,
    refetchInterval: 30_000,
  });
}

/** "Notify me when a driver is available" (spec §5) — one active watch. */
export function useWatchAvailability() {
  return useMutation({
    mutationFn: (point: Point) => unwrap(rideApi.watchAvailability(point)),
    onSuccess: () => track('ride_supply_watch', {}),
  });
}

/** Honest supply counts [rides spec 5.5A / S-41]: "{online} online — {busy}
 *  on trips", straight from the server. Real numbers are respect; never
 *  rendered from a guess. */
export function useRideSupply(point?: Point) {
  return useQuery<{ online: number; busy: number; level: 'GOOD' | 'LOW' | 'NONE'; nearestEtaMinutes: number | null }>({
    queryKey: ['rides', 'supply', point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : null],
    queryFn: () => unwrap(rideApi.supply(point as Point)),
    enabled: !!point,
    refetchInterval: 30_000,
  });
}

/** [rides 5.1/6.2] The "map is alive" read: up to 12 COARSE, server-jittered
 *  free cars near the pickup. The jitter is the server's privacy design —
 *  no identities, no bearings, positions stable per 5-minute bucket. An empty
 *  answer means the map draws nothing: absence is never dressed as supply. */
export function useRidePresence(point?: Point) {
  return useQuery<{ cars: { lat: number; lng: number }[] }>({
    queryKey: ['rides', 'presence', point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : null],
    queryFn: () => unwrap(rideApi.presence(point as Point)),
    enabled: !!point,
    refetchInterval: 60_000,
  });
}

export type QueueStatus = {
  id: string;
  position: number;
  joinedAt: string;
  expiresAt: string;
  suppliersOnline: number;
  suppliersBusy: number;
};

/** My place in line [5.5B] — null when not queued. Polls alongside the
 *  active-ride poll; a queue match creates a real ride server-side, so the
 *  active-ride query is what flips the screen. */
export function useQueueStatus(enabled = true) {
  return useQuery<QueueStatus | null>({
    queryKey: ['rides', 'queue'],
    queryFn: () => unwrap<QueueStatus | null>(rideApi.queueStatus()),
    enabled,
    refetchInterval: enabled ? 15_000 : undefined,
  });
}

export function useJoinQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      pickup: Point;
      dropoff: Point;
      pickupAddress: string;
      dropoffAddress: string;
      passengerCount?: number;
      rideClass?: RideClass;
    }) => unwrap<QueueStatus>(rideApi.queueJoin(data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rides', 'queue'] });
      track('ride_queue_joined', {});
    },
  });
}

export function useLeaveQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(rideApi.queueLeave()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rides', 'queue'] });
      track('ride_queue_left', {});
    },
  });
}

/**
 * Book the ride. [TAXI multi-stop] Every request carries the booking intent's
 * Idempotency-Key (lib/rideRequestAttempt): a retry of the same trip — after a
 * timeout, a lost answer or an app restart — sends the same key, so the server
 * replays the ride it already made instead of booking twice.
 */
export function useRequestRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: RideRequestBody) => {
      const key = rideRequestAttempt.keyFor(data, getAuthSessionSnapshot()?.userId ?? '');
      return unwrap(rideApi.request(data, key));
    },
    onSuccess: () => {
      // Answered (a new ride, or the replay of one already made): the key is spent.
      rideRequestAttempt.settle();
      qc.invalidateQueries({ queryKey: ['rides', 'active'] });
      track('ride_requested', {});
    },
    onError: (error) => {
      const code = errorCodeOf(error);
      const answered = !!(error as { response?: unknown } | null)?.response;
      // The ride may exist without its answer having reached the phone: read
      // the live ride before anything else (CONTRACT §3.1 #18), never book again.
      if (!answered || code === 'RIDE_REQUEST_OUTCOME_UNKNOWN' || code === 'DUPLICATE_REQUEST' || code === 'RIDE_IN_PROGRESS') {
        void qc.invalidateQueries({ queryKey: ['rides', 'active'] });
      }
      // The server refused the key itself: the next tap starts a new intent.
      if (code === 'IDEMPOTENCY_KEY_REUSED') {
        rideRequestAttempt.settle();
        void qc.invalidateQueries({ queryKey: ['rides', 'active'] });
      }
      // The quote moved under the passenger: fetch the new one to show.
      if (code === 'FARE_CHANGED') void qc.invalidateQueries({ queryKey: ['rides', 'estimate'] });
      // The stop switch moved: re-read how many stops this server takes.
      if (code === 'MULTI_STOP_UNAVAILABLE' || code === 'TOO_MANY_STOPS') void qc.invalidateQueries({ queryKey: ['rides', 'capabilities'] });
    },
  });
}

export function useCancelRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => unwrap(rideApi.cancel(id, reason)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rides', 'active'] });
      // Home's live-order card shows the ride too. Without this it keeps the
      // cancelled ride on screen until the customer happens to pull to refresh.
      void qc.invalidateQueries({ queryKey: customerKeys.homeAll });
    },
  });
}

/** [E19] The passenger can see the car at the kerb; their confirm is the
 *  one-tap override that keeps a driver with a stale or missing GPS fix from
 *  ever being stranded by the arrival gate. */
export function useConfirmDriverArrival() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => unwrap(rideApi.confirmDriverArrival(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rides', 'active'] });
      void qc.invalidateQueries({ queryKey: customerKeys.homeAll });
    },
  });
}

/** Raise an emergency on an active ride (rides safety spec). The app also dials
 *  the local emergency number; this records the incident and pages ops so a
 *  panic is never just a dropped call. Coords help ops locate the rider. */
export function useRideSos() {
  return useMutation({
    mutationFn: ({ id, coords }: { id: string; coords?: { lat: number; lng: number } }) => unwrap(rideApi.sos(id, coords)),
    onSuccess: () => track('ride_sos', {}),
  });
}
