import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { riderApi, driverApi } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}
async function tryUnwrap<T = any>(p: Promise<any>): Promise<T | null> {
  try {
    return await unwrap<T>(p);
  } catch {
    return null;
  }
}

export type MoverKind = 'DRIVER' | 'RIDER';
function svc(kind: MoverKind) {
  return kind === 'DRIVER' ? driverApi : riderApi;
}

/** Detect whether this mover is a Driver (taxi) or Rider (delivery), probing driver first. */
export function useMoverKind() {
  const driver = useQuery({ queryKey: ['mover', 'driverProfile'], queryFn: () => tryUnwrap(driverApi.profile()), retry: false });
  const rider = useQuery({
    queryKey: ['mover', 'riderProfile'],
    queryFn: () => tryUnwrap(riderApi.profile()),
    retry: false,
    enabled: driver.data === null,
  });
  const kind: MoverKind | null = driver.data ? 'DRIVER' : rider.data ? 'RIDER' : null;
  const profile: any = driver.data ?? rider.data ?? null;
  const loading = driver.isLoading || (driver.data === null && rider.isLoading);
  return { kind, profile, loading };
}

export function useEarningsToday(kind: MoverKind | null) {
  return useQuery({
    queryKey: ['mover', 'earnings', kind],
    queryFn: () => unwrap(svc(kind as MoverKind).earningsToday()),
    enabled: !!kind,
  });
}
export function useEarningsSummary<T = any>(kind: MoverKind | null) {
  return useQuery<T>({
    queryKey: ['mover', 'earnings-summary', kind],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).earningsSummary()),
    enabled: !!kind,
  });
}
export function useEarnings<T = any>(kind: MoverKind | null) {
  return useQuery<T>({
    queryKey: ['mover', 'earnings-history', kind],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).earnings()),
    enabled: !!kind,
  });
}
export function useAvailableJobs(kind: MoverKind | null, online: boolean) {
  return useQuery({
    queryKey: ['mover', 'available', kind],
    queryFn: () => unwrap(svc(kind as MoverKind).available()),
    enabled: !!kind && online,
    refetchInterval: online ? 10000 : false,
  });
}
export function useActiveJob(kind: MoverKind | null) {
  return useQuery({
    queryKey: ['mover', 'active', kind],
    queryFn: () => unwrap(svc(kind as MoverKind).active()),
    enabled: !!kind,
    refetchInterval: 12000,
  });
}
export function useGoOnline(kind: MoverKind) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(svc(kind).goOnline()), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
}
export function useGoOffline(kind: MoverKind) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(svc(kind).goOffline()), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
}
export function useAcceptJob(kind: MoverKind) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, fare }: { id: string; fare?: number }) => unwrap(svc(kind).accept(id, fare)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
}
export function useDriverAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, pin }: { id: string; action: 'en-route' | 'arrived' | 'verify-pin' | 'start' | 'complete'; pin?: string }) => {
      if (action === 'en-route') return unwrap(driverApi.enRoute(id));
      if (action === 'arrived') return unwrap(driverApi.arrived(id));
      if (action === 'verify-pin') return unwrap(driverApi.verifyPin(id, pin ?? ''));
      if (action === 'start') return unwrap(driverApi.start(id));
      return unwrap(driverApi.complete(id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
  });
}
export function useRiderAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'handover' | 'delivered' }) =>
      action === 'handover' ? unwrap(riderApi.handover(id)) : unwrap(riderApi.delivered(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
  });
}

/**
 * Streams the mover's device GPS to the backend while they're online. Each PUT
 * persists the position AND (server-side) broadcasts `driver:location` /
 * `rider:location` to the active order's room — this is what makes the
 * customer's live driver marker actually move. Watches by distance + time so a
 * parked mover doesn't spam writes; never throws (failed sends are ignored).
 */
export function useBroadcastLocation(kind: MoverKind | null, enabled: boolean) {
  useEffect(() => {
    if (!kind || !enabled) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | undefined;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 8000 },
          (pos) => {
            void svc(kind).location(pos.coords.latitude, pos.coords.longitude).catch(() => {});
          },
        );
      } catch {
        // Location unavailable / permission denied — go-online still works; the
        // customer just won't see a moving marker. Non-fatal.
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [kind, enabled]);
}

export interface DispatchOffer {
  orderId: string;
  orderNumber?: string;
  vendorName?: string;
  expiresInSeconds?: number;
  etaMinutes?: number;
}

/**
 * Real-time dispatch offers. The backend emits `dispatch:offer` to the mover's
 * user room the moment they're the top candidate; we surface it instantly and
 * refresh the available list. Polling (useAvailableJobs) stays as a fallback,
 * so a missed socket event still resolves within the poll interval.
 */
export function useDispatchOffers(kind: MoverKind | null, online: boolean) {
  const qc = useQueryClient();
  const [offer, setOffer] = useState<DispatchOffer | null>(null);

  useEffect(() => {
    if (!kind || !online) {
      setOffer(null);
      return;
    }
    connectSocket();
    const s = getSocket();
    const onOffer = (data: DispatchOffer) => {
      setOffer(data);
      qc.invalidateQueries({ queryKey: ['mover', 'available', kind] });
    };
    s.on('dispatch:offer', onOffer);
    return () => {
      s.off('dispatch:offer', onOffer);
    };
  }, [kind, online, qc]);

  // Auto-dismiss once the offer window lapses (the backend reassigns it).
  useEffect(() => {
    if (!offer?.expiresInSeconds) return;
    const t = setTimeout(() => setOffer(null), offer.expiresInSeconds * 1000);
    return () => clearTimeout(t);
  }, [offer]);

  return { offer, dismiss: () => setOffer(null) };
}
