import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { riderApi, driverApi } from '../services/api';
import { track } from '../lib/analytics';
import { connectSocket, getSocket } from '../services/socket';
import { startMoverLocation, stopMoverLocation } from '../services/backgroundLocation';

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

/** Upload the PUBLIC vehicle photo customers see on acceptance (§5). */
export function useUploadVehiclePhoto(kind: MoverKind | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: { uri: string; name: string; type: string }) => {
      const form = new FormData();
      form.append('file', file as unknown as Blob);
      return unwrap(svc(kind as MoverKind).uploadVehiclePhoto(form));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mover', 'driverProfile'] });
      qc.invalidateQueries({ queryKey: ['mover', 'riderProfile'] });
    },
  });
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
/** DASH-03: server-aggregated per-Guyana-day totals for the Home trend chart —
 *  replaces the client-side grouping of the paginated earnings list. */
export function useDailyEarnings<T = any>(kind: MoverKind | null, days = 7) {
  return useQuery<T>({
    queryKey: ['mover', 'earnings-daily', kind, days],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).earningsDaily(days)),
    enabled: !!kind,
  });
}
/** Nearby REAL demand for the dashboard (plan Phase A): waiting taxi
 *  requests + watchers for drivers; unassigned orders by store for riders. */
export function useDemand<T = any>(kind: MoverKind | null, point?: { lat: number; lng: number }) {
  return useQuery<T>({
    queryKey: ['mover', 'demand', kind, point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : null],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).demand(point as { lat: number; lng: number })),
    enabled: !!kind && !!point,
    refetchInterval: 20_000,
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
  return useMutation({
    mutationFn: () => unwrap(svc(kind).goOnline()),
    // MoverHomeScreen renders goOnline.error inline (the verification/selfie/
    // subscription reason) — opt out of the global toast to avoid doubling.
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mover'] });
      track('go_online', { kind });
    },
  });
}
export function useGoOffline(kind: MoverKind) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(svc(kind).goOffline()), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
}
export function useAcceptJob(kind: MoverKind) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, fare }: { id: string; fare?: number }) => unwrap(svc(kind).accept(id, fare)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
}
/** Accept a dispatch OFFER (the offer card), not a board grab. Hits
 *  /offers/accept, which acknowledges the offer so accepting is never scored as
 *  a timeout and the mover's acceptance rate goes UP, not down [SWIFT-016]. */
export function useAcceptOffer(kind: MoverKind) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ orderId, fare }: { orderId: string; fare?: number }) => unwrap(svc(kind).acceptOffer(orderId, fare)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
}
/** Explicit pass on a dispatch offer — tells the cascade to move to the next
 *  mover NOW instead of letting the 20s timeout burn. Best-effort: if the
 *  offer already expired server-side the decline 409s, which is fine. */
export function useDeclineOffer(kind: MoverKind) {
  return useMutation({
    mutationFn: (orderId: string) => svc(kind).declineOffer(orderId).catch(() => null),
    onSuccess: () => track('offer_declined', { kind }),
  });
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
export type RiderAction =
  | 'en-route-pickup' | 'arrived-pickup' | 'picked-up' | 'en-route-delivery' | 'arrived'
  | 'handover' | 'delivered';

export function useRiderAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, action }: { id: string; action: RiderAction }) => {
      switch (action) {
        case 'en-route-pickup': return unwrap(riderApi.enRoutePickup(id));
        case 'arrived-pickup': return unwrap(riderApi.arrivedPickup(id));
        case 'picked-up': return unwrap(riderApi.pickedUp(id));
        case 'en-route-delivery': return unwrap(riderApi.enRouteDelivery(id));
        case 'arrived': return unwrap(riderApi.arrivedAtCustomer(id));
        case 'delivered': return unwrap(riderApi.delivered(id));
        case 'handover': {
          // The golden-rule handover NEEDS the rider's GPS (server-side mandatory —
          // it's the evidence a guarantee claim stands on). Last-known is instant;
          // fall back to a fresh fix.
          const pos =
            (await Location.getLastKnownPositionAsync().catch(() => null)) ??
            (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
          return unwrap(riderApi.handover(id, { outcome: 'paid', gps: { lat: pos.coords.latitude, lng: pos.coords.longitude } }));
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
  });
}

/** MMG cash ledger — delivery fees stores owe this rider (the customer paid
 *  the store via MMG, so the store hands the fee over in cash). Rider-only. */
export function useCashSettlements(kind: MoverKind | null) {
  return useQuery({
    queryKey: ['mover', 'cash-settlements'],
    queryFn: () => unwrap<any>(riderApi.cashSettlements()),
    enabled: kind === 'RIDER',
  });
}
/** "The store handed me the cash" — my half of the dual confirm. */
export function useConfirmCashSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(riderApi.confirmCashSettlement(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover', 'cash-settlements'] }),
  });
}

/** Rider ops stats — online hours today (Redis-accumulated) + week deliveries.
 *  The driver module has no /stats route, so this is rider-only. */
export function useMoverStats(kind: MoverKind | null) {
  return useQuery({
    queryKey: ['mover', 'stats'],
    queryFn: () => unwrap<any>(riderApi.stats()),
    enabled: kind === 'RIDER',
    refetchInterval: 60000,
  });
}

/** Finished-job history: driver rides (status-filterable) / rider deliveries. */
export function useJobHistory(kind: MoverKind | null, page: number, status?: string) {
  return useQuery({
    queryKey: ['mover', 'history', kind, page, status ?? 'all'],
    queryFn: async () => {
      const r =
        kind === 'DRIVER'
          ? await driverApi.rides({ page, limit: 20, ...(status ? { status } : {}) })
          : await riderApi.history({ page, limit: 20 });
      return r?.data as { data: any[]; meta: { page: number; limit: number; total: number; hasNext: boolean } };
    },
    enabled: !!kind,
    placeholderData: (prev) => prev,
  });
}

/** The mover's own weekly flat-fee subscription (trial/grace/rate/next bill). */
export function useMoverSubscription(kind: MoverKind | null) {
  return useQuery({
    queryKey: ['mover', 'subscription', kind],
    queryFn: () => tryUnwrap<any>(svc(kind as MoverKind).subscription()),
    enabled: !!kind,
  });
}

/** Post-trip DRIVER_TO_CUSTOMER rating (409 when already rated — treat as done). */
export function useRateCustomer() {
  return useMutation({
    mutationFn: ({ id, score }: { id: string; score: number }) => unwrap(driverApi.rateCustomer(id, score)),
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
    let background = false;

    (async () => {
      try {
        // Prefer the background task so the marker keeps moving when the driver
        // switches to Maps or locks the screen. If background isn't available
        // (permission denied, or the native module isn't in this build yet),
        // fall back to the foreground watcher — same behaviour as before.
        background = await startMoverLocation(kind);
        if (background || cancelled) return;

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
      if (background) void stopMoverLocation();
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
