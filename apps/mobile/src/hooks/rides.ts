import { track } from '../lib/analytics';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rideApi, type RideClass, type TieredEstimate } from '../services/api';

type Point = { lat: number; lng: number };

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

/** Tiered fares (Economy/Comfort/XL) for the request screen. */
export function useRideEstimate(pickup?: Point, dropoff?: Point) {
  return useQuery<TieredEstimate>({
    queryKey: ['rides', 'estimate', pickup, dropoff],
    queryFn: () => unwrap<TieredEstimate>(rideApi.estimate(pickup as Point, dropoff as Point)),
    enabled: !!pickup && !!dropoff,
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

export function useRequestRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      pickup: Point;
      dropoff: Point;
      pickupAddress: string;
      dropoffAddress: string;
      passengerCount?: number;
      rideClass?: RideClass;
    }) => unwrap(rideApi.request(data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rides', 'active'] });
      track('ride_requested', {});
    },
  });
}

export function useCancelRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => unwrap(rideApi.cancel(id, reason)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rides', 'active'] }),
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
