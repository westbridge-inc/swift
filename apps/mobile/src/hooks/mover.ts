import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customerApi, riderApi, driverApi } from '../services/api';
import { track } from '../lib/analytics';
import { connectSocket, getSocket } from '../services/socket';
import {
  publishMoverLocation,
  startMoverLocation,
  stopMoverLocation,
} from '../services/backgroundLocation';
import { useMoverPreview } from '../stores/moverPreview';
import { useLocationStore } from '../stores/locationStore';
import {
  AuthSessionBoundaryError,
  getAuthSessionSnapshot,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';
import { samePrincipalBoundary, type AuthSessionSnapshot } from '../lib/authSession';
import {
  commitLiveDeviceLocation,
  createLiveDeviceLocationLease,
  isLiveDeviceLocationLeaseValid,
} from '../lib/deviceLocation';
import {
  sharedMoverLocationController,
  type MoverKind,
} from '../lib/moverLocation';
import * as PV from '../lib/moverPreviewData';
import {
  resolveMoverProfile,
  unwrapOptionalMoverProfile,
} from '../lib/moverProfile';
import { canonicalMoverAuthority } from '../lib/moverAuthorityCache';

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

export type { MoverKind } from '../lib/moverLocation';
function svc(kind: MoverKind) {
  return kind === 'DRIVER' ? driverApi : riderApi;
}

// Earner PREVIEW (R3): a prospective mover sees the REAL screens fed sample data.
// Every DATA hook returns a resolved preview query (with its real query disabled
// so no auth-less request fires); every MUTATION hook returns a no-op — preview
// is strictly read-only. `usePreview()` is called unconditionally in each hook so
// hook order is stable (rules of hooks).
function usePreview() {
  return useMoverPreview((s) => s.preview);
}

/** Resolve both operational profiles. A missing profile is a successful 404;
 * transient failures stay visible and are retried a bounded number of times.
 * Querying both lets live work outrank stale cross-device role memory without
 * ever treating a network error as permission to cross into the other app. */
export function useMoverKind() {
  const pv = usePreview();
  const pvKind = useMoverPreview((s) => s.kind);
  const authority = useAuthStore((s) => s.user) as (Parameters<ReturnType<typeof useAuthStore.getState>['setUserIfCurrent']>[1] & {
    activeRole?: string;
    lastMoverRole?: string | null;
  }) | null;
  const setUserIfCurrent = useAuthStore((s) => s.setUserIfCurrent);
  const retryDelay = (attempt: number) => Math.min(500 * (2 ** attempt), 2_000);
  const driver = useQuery<any | null>({
    queryKey: ['mover', 'driverProfile'],
    queryFn: () => unwrapOptionalMoverProfile(driverApi.profile()),
    retry: 2,
    retryDelay,
    enabled: !pv,
  });
  const rider = useQuery<any | null>({
    queryKey: ['mover', 'riderProfile'],
    queryFn: () => unwrapOptionalMoverProfile(riderApi.profile()),
    retry: 2,
    retryDelay,
    enabled: !pv,
  });
  const serverAuthority = driver.data?.user ?? rider.data?.user;
  const serverActiveRole = typeof serverAuthority?.activeRole === 'string'
    ? serverAuthority.activeRole
    : authority?.activeRole;
  const serverLastMoverRole = typeof serverAuthority?.lastMoverRole === 'string'
    ? serverAuthority.lastMoverRole
    : serverAuthority?.lastMoverRole === null
      ? null
      : authority?.lastMoverRole;

  // Profile reads are also a cheap cross-device authority refresh. Persist the
  // canonical server pointer so every other navigator/switcher agrees with the
  // resolver instead of keeping a stale local role until the next login.
  useEffect(() => {
    if (
      pv
      || !authority
      || !serverAuthority
      || (serverAuthority.id && serverAuthority.id !== authority.id)
      || (authority.activeRole === serverActiveRole
        && authority.lastMoverRole === serverLastMoverRole)
    ) return;
    const owner = getAuthSessionSnapshot();
    if (!owner || owner.userId !== authority.id) return;
    setUserIfCurrent(owner, {
      ...authority,
      activeRole: serverActiveRole,
      lastMoverRole: serverLastMoverRole,
    } as Parameters<typeof setUserIfCurrent>[1]);
  }, [authority, pv, serverActiveRole, serverAuthority, serverLastMoverRole, setUserIfCurrent]);

  if (pv) {
    return {
      kind: pvKind as MoverKind,
      profile: PV.PREVIEW_PROFILE as any,
      loading: false,
      refetching: false,
      error: null,
      ambiguous: false,
      refetch: async () => {},
    };
  }

  const loading = driver.isLoading || rider.isLoading;
  const error = driver.error ?? rider.error ?? null;
  const resolution = !loading && !error
      ? resolveMoverProfile({
        activeRole: serverActiveRole,
        lastMoverRole: serverLastMoverRole,
        driver: driver.data ?? null,
        rider: rider.data ?? null,
      })
    : { kind: null, profile: null, ambiguous: false };

  return {
    ...resolution,
    loading,
    refetching: driver.isFetching || rider.isFetching,
    error,
    refetch: async () => {
      await Promise.all([driver.refetch(), rider.refetch()]);
    },
  };
}

/** Upload the PUBLIC vehicle photo customers see on acceptance (§5). */
export function useUploadVehiclePhoto(kind: MoverKind | null) {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async (input: {
      uri: string;
      name: string;
      type: string;
      authSession?: AuthSessionSnapshot;
    }) => {
      const { authSession, ...file } = input;
      const owner = authSession ?? requireAuthSessionSnapshot();
      const current = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', file as unknown as Blob);
      const result = await unwrap(svc(kind as MoverKind).uploadVehiclePhoto(form, current));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mover', 'driverProfile'] });
      qc.invalidateQueries({ queryKey: ['mover', 'riderProfile'] });
    },
  });
  return pv ? PV.previewMutation() : m;
}

export function useEarningsToday(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'earnings', kind],
    queryFn: () => unwrap(svc(kind as MoverKind).earningsToday()),
    enabled: !!kind && !pv,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_EARNINGS_TODAY) : q;
}
export function useEarningsSummary<T = any>(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery<T>({
    queryKey: ['mover', 'earnings-summary', kind],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).earningsSummary()),
    enabled: !!kind && !pv,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_EARNINGS_SUMMARY) : q;
}
export function useEarnings<T = any>(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery<T>({
    queryKey: ['mover', 'earnings-history', kind],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).earnings()),
    enabled: !!kind && !pv,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_EARNINGS) : q;
}
/** Movement R9: the daily-folded Standing view (RAT-G — never same-day). */
export function useMoverStanding<T = any>(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery<T>({
    queryKey: ['mover', 'standing', kind],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).standing()),
    enabled: !!kind && !pv,
  });
  return pv ? PV.previewQuery(null as T) : q;
}

/** DASH-03: server-aggregated per-Guyana-day totals for the Home trend chart —
 *  replaces the client-side grouping of the paginated earnings list. */
export function useDailyEarnings<T = any>(kind: MoverKind | null, days = 7) {
  const pv = usePreview();
  const q = useQuery<T>({
    queryKey: ['mover', 'earnings-daily', kind, days],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).earningsDaily(days)),
    enabled: !!kind && !pv,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_DAILY_EARNINGS) : q;
}
/** Nearby REAL demand for the dashboard (plan Phase A): waiting taxi
 *  requests + watchers for drivers; unassigned orders by store for riders. */
export function useDemand<T = any>(kind: MoverKind | null, point?: { lat: number; lng: number }) {
  const pv = usePreview();
  const q = useQuery<T>({
    queryKey: ['mover', 'demand', kind, point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : null],
    queryFn: () => unwrap<T>(svc(kind as MoverKind).demand(point as { lat: number; lng: number })),
    enabled: !!kind && !!point && !pv,
    refetchInterval: 20_000,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_DEMAND) : q;
}

export function useAvailableJobs(kind: MoverKind | null, online: boolean) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'available', kind],
    queryFn: () => unwrap(svc(kind as MoverKind).available()),
    enabled: !!kind && online && !pv,
    refetchInterval: online ? 10000 : false,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_AVAILABLE) : q;
}
export function useActiveJob(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'active', kind],
    queryFn: () => unwrap(svc(kind as MoverKind).active()),
    enabled: !!kind && !pv,
    refetchInterval: 12000,
  });
  // A sample in-progress trip in preview: Home shows the active-trip banner (its
  // "tap to manage" is the only path to the nav-grade Active-trip screen, which
  // R3 requires be previewable) while the map still renders demand behind it.
  return pv ? PV.previewQuery(PV.PREVIEW_ACTIVE_JOB) : q;
}
/** [B6] The run summary the server computes for a stacked rider. Rendered,
 *  never re-derived: the strip shows `cashToCollect`, it does not add it. */
export type RunSummary = {
  drops: number;
  cashToCollect: number;
  next: { orderId: string; vendorName: string | null; status: string };
};

/**
 * [B6] Every live leg — the primary first — plus the run summary. The singular
 * case is `useActiveJob` untouched: one leg, no run, the same query. Taxi is
 * one-at-a-time by law, so a driver's list is their active ride alone, and
 * preview keeps its single sample trip.
 */
export function useActiveJobs(kind: MoverKind | null) {
  const pv = usePreview();
  const single = useActiveJob(kind);
  const stacked = kind === 'RIDER' && !pv;
  const legsQ = useQuery({
    queryKey: ['mover', 'active', kind, 'legs'],
    queryFn: () => unwrap<{ legs: any[]; run: RunSummary | null }>(riderApi.activeLegs()),
    enabled: stacked,
    refetchInterval: 12000,
  });
  const fromSingle: any[] = single.data ? [single.data] : [];
  if (!stacked) return { legs: fromSingle, run: null as RunSummary | null, refetch: single.refetch };
  return {
    legs: (legsQ.data?.legs as any[] | undefined) ?? fromSingle,
    run: legsQ.data?.run ?? null,
    refetch: legsQ.refetch,
  };
}
export function useGoOnline(kind: MoverKind) {
  const pv = usePreview();
  const qc = useQueryClient();
  const setUserIfCurrent = useAuthStore((s) => s.setUserIfCurrent);
  const m = useMutation({
    mutationFn: async ({ latitude, longitude, authSession }: {
      latitude: number;
      longitude: number;
      authSession?: AuthSessionSnapshot;
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      let current = requireAuthSessionForPrincipal(owner);
      const user = useAuthStore.getState().user as (Parameters<
        typeof setUserIfCurrent
      >[1] & { lastMoverRole?: string | null }) | null;
      if (!user || user.id !== owner.userId) throw new AuthSessionBoundaryError();
      // GO is an explicit authority acquisition, including after another device
      // last used the customer/business surface. Serialize it through the same
      // server role transition that safely removes supply when switching away.
      const authorityRole = kind;
      const response = await customerApi.switchRole(authorityRole, current);
      current = requireAuthSessionForPrincipal(owner);
      const canonical = canonicalMoverAuthority(
        response?.data?.data,
        authorityRole,
        user.lastMoverRole,
      );
      if (!setUserIfCurrent(owner, {
        ...user,
        ...canonical,
      } as unknown as Parameters<typeof setUserIfCurrent>[1])) {
        throw new AuthSessionBoundaryError();
      }
      const result = await unwrap(svc(kind).goOnline(latitude, longitude, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['mover'] });
      track('go_online', { kind });
      return result;
    },
    // MoverHomeScreen renders goOnline.error inline (the verification/selfie/
    // subscription reason) — opt out of the global toast to avoid doubling.
    meta: { silent: true },
  });
  return pv ? PV.previewMutation() : m;
}

/** Resolve an ambiguous legacy dual-profile account through an explicit human
 * choice. The server serializes the transition and returns canonical authority;
 * the subsequent profile refetch cannot inherit stale sibling-online state. */
export function useSelectMoverKind() {
  const qc = useQueryClient();
  const setUserIfCurrent = useAuthStore((s) => s.setUserIfCurrent);
  return useMutation({
    mutationFn: async (kind: MoverKind) => {
      const owner = requireAuthSessionSnapshot();
      const user = useAuthStore.getState().user as (Parameters<
        typeof setUserIfCurrent
      >[1] & { lastMoverRole?: string | null }) | null;
      if (!user || user.id !== owner.userId) throw new AuthSessionBoundaryError();
      const response = await customerApi.switchRole(kind, owner);
      requireAuthSessionForPrincipal(owner);
      const canonical = canonicalMoverAuthority(
        response?.data?.data,
        kind,
        user.lastMoverRole,
      );
      if (!setUserIfCurrent(owner, {
        ...user,
        ...canonical,
      } as unknown as Parameters<typeof setUserIfCurrent>[1])) {
        throw new AuthSessionBoundaryError();
      }
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return canonical;
    },
  });
}
export function useGoOffline(kind: MoverKind) {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: () => unwrap(svc(kind).goOffline()), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
  return pv ? PV.previewMutation() : m;
}
export function useAcceptJob(kind: MoverKind) {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: ({ id, fare }: { id: string; fare?: number }) => unwrap(svc(kind).accept(id, fare)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
  return pv ? PV.previewMutation() : m;
}
/** Accept a dispatch OFFER (the offer card), not a board grab. Hits
 *  /offers/accept, which acknowledges the offer so accepting is never scored as
 *  a timeout and the mover's acceptance rate goes UP, not down [SWIFT-016]. */
export function useAcceptOffer(kind: MoverKind) {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: ({ orderId, fare, offerAttemptId }: { orderId: string; fare?: number; offerAttemptId?: string }) => unwrap(svc(kind).acceptOffer(orderId, fare, offerAttemptId)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
  return pv ? PV.previewMutation() : m;
}
/** Explicit pass on a dispatch offer — tells the cascade to move to the next
 *  mover NOW instead of letting the 20s timeout burn.
 *  [WR-010] A failed decline is NOT a success: dispatch keeps offering this
 *  mover until the timeout burns, and the pass can be scored as a timeout
 *  instead of a decline. An offer that's already gone server-side (409/404/
 *  410) IS success — the cascade moved on. Everything else gets one retry,
 *  then surfaces to the caller. */
export function useDeclineOffer(kind: MoverKind) {
  const pv = usePreview();
  const m = useMutation({
    mutationFn: async ({ orderId, offerAttemptId }: { orderId: string; offerAttemptId?: string }) => {
      const gone = (e: unknown) => [404, 409, 410].includes(Number((e as { response?: { status?: number } })?.response?.status));
      try {
        return await svc(kind).declineOffer(orderId, offerAttemptId);
      } catch (e) {
        if (gone(e)) return null;
        try {
          return await svc(kind).declineOffer(orderId, offerAttemptId);
        } catch (e2) {
          if (gone(e2)) return null;
          throw e2;
        }
      }
    },
    onSuccess: () => track('offer_declined', { kind }),
  });
  return pv ? PV.previewMutation() : m;
}
export type FareOutcome = 'paid' | 'refused' | 'no_show';
export type DriverAction = 'en-route' | 'arrived' | 'verify-pin' | 'start' | 'handover';
export type DriverActionInput =
  | { id: string; action: Exclude<DriverAction, 'handover'>; pin?: string }
  /** [M-29] The fare outcome is explicit — never defaulted — because it moves money. */
  | { id: string; action: 'handover'; outcome: FareOutcome };

/** The evidence fix for a handover / fare outcome. The server REQUIRES the
 *  mover's GPS (it is what a guarantee claim stands on). Last-known is
 *  instant; fall back to a fresh fix. The auth principal is re-checked around
 *  the wait so a session that changed underneath cannot sign the outcome. */
export async function evidenceFix(owner: AuthSessionSnapshot) {
  let pos = await Location.getLastKnownPositionAsync().catch(() => null);
  let current = requireAuthSessionForPrincipal(owner);
  if (!pos) {
    pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    current = requireAuthSessionForPrincipal(owner);
  }
  return { gps: { lat: pos.coords.latitude, lng: pos.coords.longitude }, current };
}

export function useDriverAction() {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async (input: DriverActionInput) => {
      const { id } = input;
      if (input.action === 'handover') {
        // [M-29] The fare outcome at the destination IS the ride's completion:
        // 'paid' captures and completes in one commit; 'refused' / 'no_show'
        // fail it with this GPS as evidence, strike the passenger and open the
        // driver's guarantee claim. No bare "complete" exists any more.
        const owner = requireAuthSessionSnapshot();
        const { gps, current } = await evidenceFix(owner);
        const result = await unwrap(driverApi.handover(id, { outcome: input.outcome, gps }, current));
        requireAuthSessionForPrincipal(owner);
        return result;
      }
      if (input.action === 'en-route') return unwrap(driverApi.enRoute(id));
      if (input.action === 'arrived') return unwrap(driverApi.arrived(id));
      if (input.action === 'verify-pin') return unwrap(driverApi.verifyPin(id, input.pin ?? ''));
      return unwrap(driverApi.start(id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
  });
  return pv ? PV.previewMutation() : m;
}
export type RiderAction =
  | 'en-route-pickup' | 'arrived-pickup' | 'picked-up' | 'en-route-delivery' | 'arrived'
  | 'handover' | 'delivered' | 'handback';

export function useRiderAction() {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ id, action, reason, outcome }: { id: string; action: RiderAction; reason?: string; outcome?: FareOutcome }) => {
      switch (action) {
        case 'en-route-pickup': return unwrap(riderApi.enRoutePickup(id));
        case 'arrived-pickup': return unwrap(riderApi.arrivedPickup(id));
        case 'picked-up': return unwrap(riderApi.pickedUp(id));
        case 'en-route-delivery': return unwrap(riderApi.enRouteDelivery(id));
        case 'arrived': return unwrap(riderApi.arrivedAtCustomer(id));
        case 'delivered': return unwrap(riderApi.delivered(id));
        case 'handback': return unwrap(riderApi.handback(id, reason ?? 'unable to continue'));
        case 'handover': {
          const owner = requireAuthSessionSnapshot();
          // The golden-rule handover NEEDS the rider's GPS (server-side mandatory —
          // it's the evidence a guarantee claim stands on). 'paid' is the door's
          // default; [M-29] 'refused' / 'no_show' are the failed outcomes the
          // unpaid sheet sends explicitly.
          const { gps, current } = await evidenceFix(owner);
          const result = await unwrap(riderApi.handover(id, { outcome: outcome ?? 'paid', gps }, current));
          requireAuthSessionForPrincipal(owner);
          return result;
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
  });
  return pv ? PV.previewMutation() : m;
}

/** MMG cash ledger — delivery fees stores owe this rider (the customer paid
 *  the store via MMG, so the store hands the fee over in cash). Rider-only. */
export function useCashSettlements(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'cash-settlements'],
    queryFn: () => unwrap<any>(riderApi.cashSettlements()),
    enabled: kind === 'RIDER' && !pv,
  });
  return pv ? PV.previewQuery([]) : q;
}
/** "The store handed me the cash" — my half of the dual confirm. */
export function useConfirmCashSettlement() {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (id: string) => unwrap(riderApi.confirmCashSettlement(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover', 'cash-settlements'] }),
  });
  return pv ? PV.previewMutation() : m;
}

/** Rider ops stats — online hours today (Redis-accumulated) + week deliveries.
 *  The driver module has no /stats route, so this is rider-only. */
export function useMoverStats(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'stats'],
    queryFn: () => unwrap<any>(riderApi.stats()),
    enabled: kind === 'RIDER' && !pv,
    refetchInterval: 60000,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_STATS) : q;
}

/** Finished-job history: driver rides (status-filterable) / rider deliveries. */
export function useJobHistory(kind: MoverKind | null, page: number, status?: string) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'history', kind, page, status ?? 'all'],
    queryFn: async () => {
      const r =
        kind === 'DRIVER'
          ? await driverApi.rides({ page, limit: 20, ...(status ? { status } : {}) })
          : await riderApi.history({ page, limit: 20 });
      return r?.data as { data: any[]; meta: { page: number; limit: number; total: number; hasNext: boolean } };
    },
    enabled: !!kind && !pv,
    placeholderData: (prev) => prev,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_EARNINGS) : q;
}

/** The mover's own weekly flat-fee subscription (trial/grace/rate/next bill). */
export function useMoverSubscription(kind: MoverKind | null) {
  const pv = usePreview();
  const q = useQuery({
    queryKey: ['mover', 'subscription', kind],
    queryFn: () => tryUnwrap<any>(svc(kind as MoverKind).subscription()),
    enabled: !!kind && !pv,
  });
  return pv ? PV.previewQuery(PV.PREVIEW_SUBSCRIPTION) : q;
}

/** Post-trip DRIVER_TO_CUSTOMER rating (409 when already rated — treat as done). */
export function useRateCustomer() {
  const pv = usePreview();
  const m = useMutation({
    mutationFn: ({ id, score }: { id: string; score: number }) => unwrap(driverApi.rateCustomer(id, score)),
  });
  return pv ? PV.previewMutation() : m;
}

/**
 * Streams the mover's device GPS to the backend while they're online. Each PUT
 * persists the position AND (server-side) broadcasts `driver:location` /
 * `rider:location` to the active order's room — this is what makes the
 * customer's live driver marker actually move. Watches by distance + time so a
 * parked mover doesn't spam writes; never throws (failed sends are ignored).
 */
export function useBroadcastLocation(kind: MoverKind | null, enabled: boolean) {
  const pv = usePreview();
  const qc = useQueryClient();
  const setLiveLocation = useLocationStore((s) => s.setLiveLocation);
  const locationStatus = useLocationStore((s) => s.status);
  const authGeneration = useAuthStore((s) => s.sessionGeneration);
  const authUserId = useAuthStore((s) => s.user?.id ?? null);
  const ownerRef = useRef<object>({});
  const permissionOfflineRef = useRef<MoverKind | null>(null);

  useEffect(() => {
    const owner = ownerRef.current;
    let desired = true;
    // Preview, offline mode and unresolved permission all converge on the same
    // serialized stop path. React runs cleanup before the replacement effect,
    // so a restart cannot overtake an older native stop.
    if (!kind || !enabled || pv || locationStatus !== 'granted') {
      desired = false;
      void sharedMoverLocationController.transition(owner, null);
      if (
        kind
        && enabled
        && !pv
        && locationStatus === 'denied'
        && permissionOfflineRef.current !== kind
      ) {
        // The server's short location lease is the hard safety net. Also remove
        // idle supply immediately when the OS tells us this device can no longer
        // publish; active-job conflicts deliberately keep server tracking state.
        permissionOfflineRef.current = kind;
        void svc(kind).goOffline()
          .then(() => qc.invalidateQueries({ queryKey: ['mover'] }))
          .catch(() => {
            permissionOfflineRef.current = null;
          });
      }
      return;
    }
    permissionOfflineRef.current = null;
    const authSession = getAuthSessionSnapshot();
    const principal = authUserId
      ? { generation: authGeneration, userId: authUserId }
      : null;
    if (!authSession || !principal || !samePrincipalBoundary(authSession, principal)) {
      desired = false;
      void sharedMoverLocationController.transition(owner, null);
      return;
    }
    const isPrincipalCurrent = () => (
      desired
      && samePrincipalBoundary(getAuthSessionSnapshot(), principal)
    );
    const lease = createLiveDeviceLocationLease();
    if (!lease) {
      desired = false;
      void sharedMoverLocationController.transition(owner, null);
      return;
    }

    void sharedMoverLocationController.transition(owner, {
      kind,
      principal,
      isPrincipalCurrent: () => (
        isPrincipalCurrent()
        && isLiveDeviceLocationLeaseValid(lease)
      ),
      dependencies: {
        startBackground: (moverKind, isSessionCurrent) => startMoverLocation(
          moverKind,
          () => isSessionCurrent()
            && desired
            && isLiveDeviceLocationLeaseValid(lease),
        ),
        stopBackground: async () => {
          await stopMoverLocation(principal);
        },
        watchForeground: (onSample) => Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 8000 },
          (pos) => onSample({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            // [ALG-15] What the platform reports, as it reports it — and only
            // when it reports it: an absent field stays absent, never null.
            ...(pos.coords.accuracy != null ? { accuracy: pos.coords.accuracy } : {}),
            ...((pos as { mocked?: boolean }).mocked != null ? { mocked: (pos as { mocked?: boolean }).mocked } : {}),
          }),
        ),
        refreshForegroundSample: async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const position = await Promise.race([
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('Location refresh timed out')), 10_000);
              }),
            ]);
            return {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            };
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
        commitSharedSample: (sample) => commitLiveDeviceLocation(
          lease,
          { setLiveLocation },
          sample.latitude,
          sample.longitude,
        ),
        publish: async (moverKind, sample) => {
          // Pin foreground work exactly like the headless task. The controller
          // validates user + login generation before every publish, while the
          // explicit snapshot prevents Axios from borrowing a later account's
          // token after this callback yields.
          if (!isPrincipalCurrent() || !isLiveDeviceLocationLeaseValid(lease)) return;
          const response = await publishMoverLocation(moverKind, sample, authSession);
          if (
            response.accepted === false
            && isPrincipalCurrent()
          ) {
            // Another device or an ops action revoked server authority. Stop
            // this device's native stream immediately; the profile refetch
            // makes enabled=false and prevents a stale cached restart.
            desired = false;
            void sharedMoverLocationController.transition(owner, null);
            void qc.invalidateQueries({ queryKey: ['mover'] });
          }
          return response;
        },
      },
    });

    return () => {
      // Invalidate task-manager publication synchronously; native teardown is
      // then serialized before any replacement owner starts.
      desired = false;
      void sharedMoverLocationController.transition(owner, null);
    };
  }, [
    authGeneration,
    authUserId,
    kind,
    enabled,
    pv,
    locationStatus,
    qc,
    setLiveLocation,
  ]);
}

export interface BoardJob {
  id: string;
  pickupAddress?: string | null;
  deliveryAddress?: string | null;
  dropoffAddress?: string | null;
  fareTotal?: number | string | null;
  taxiFareTotal?: number | string | null;
  deliveryFee?: number | string | null;
  // Load-bearing for the MMG fare lock: movers must never submit an MMG fare.
  paymentMethod?: 'CASH' | 'MOBILE_MONEY' | (string & {}) | null;
}

export interface DispatchOffer {
  orderId: string;
  offerAttemptId?: string;
  orderNumber?: string;
  vendorName?: string;
  expiresInSeconds?: number;
  etaMinutes?: number;
  isExpress?: boolean;
  // [ALG-06] A rescue bonus from Swift's OWN money on a re-offered job —
  // server-set, absent on a normal offer. Never the customer's or the store's
  // money and never cash in hand at the door: Swift settles it.
  rescueIncentiveGyd?: number | null;
  // Load-bearing for the MMG fare lock: movers must never submit an MMG fare.
  paymentMethod?: 'CASH' | 'MOBILE_MONEY' | (string & {});
  customerTrust?: { trustLevel: string; completedOrders: number; strikes: number } | null;
  itemCount?: number;
  estLoad?: string | null;
  // [REPORT-010 F-07] Authoritative money/route facts carried by the RECOVERY
  // payload so a rebuilt card never prices itself from a missing board row.
  deliveryFee?: number;
  tipAmount?: number;
  taxiFareTotal?: number | null;
  pickupAddress?: string | null;
  deliveryAddress?: string | null;
  // [WS-6.0] The cash-math triple, SERVER-COMPUTED. Absent on MMG (the customer
  // already paid the store) and absent whenever the server could not reconcile
  // the split — the card must render nothing rather than a breakdown that does
  // not add up. Never compute these client-side.
  cashMath?: { collectFromCustomer: number; payToVendor: number; youKeep: number } | null;
}

type RecoveredDispatchOffer = Omit<DispatchOffer, 'offerAttemptId'> & {
  offerAttemptId: string | null;
};

/**
 * Real-time dispatch offers. The backend emits `dispatch:offer` to the mover's
 * user room the moment they're the top candidate; we surface it instantly and
 * refresh the available list. Polling (useAvailableJobs) stays as a fallback,
 * so a missed socket event still resolves within the poll interval.
 */
export function useDispatchOffers(kind: MoverKind | null, online: boolean) {
  const pv = usePreview();
  const qc = useQueryClient();
  // Stacking: offers QUEUE (FIFO, deduped by orderId) instead of overwriting —
  // with capacity 2 the server may legitimately offer a second job while one
  // card is showing. The visible card is queue[0]; the rest wait their turn,
  // exactly the vendor takeover's shape. Each entry carries an ABSOLUTE
  // deadline stamped at arrival, so backgrounding cannot freeze a countdown
  // into a lie (master audit G11).
  const [offerQueue, setOfferQueue] = useState<(DispatchOffer & { deadlineAt?: number })[]>([]);
  const offer = offerQueue[0] ?? null;
  const queuedBehind = Math.max(0, offerQueue.length - 1);
  const pushOffer = (data: DispatchOffer) =>
    setOfferQueue((q) => (q.some((o) => o.orderId === data.orderId)
      ? q.map((o) => (o.orderId === data.orderId ? { ...o, ...data, deadlineAt: o.deadlineAt } : o))
      : [...q, { ...data, deadlineAt: data.expiresInSeconds ? Date.now() + data.expiresInSeconds * 1000 : undefined }]));
  const dropOffer = (orderId: string) => setOfferQueue((q) => q.filter((o) => o.orderId !== orderId));
  const setOffer = (data: DispatchOffer | null) => {
    if (data === null) setOfferQueue((q) => q.slice(1));
    else pushOffer(data);
  };

  useEffect(() => {
    // No live offers in preview (read-only, no socket/auth).
    if (!kind || !online || pv) {
      setOfferQueue([]);
      return;
    }
    connectSocket();
    const s = getSocket();
    const api = kind === 'DRIVER' ? driverApi : riderApi;
    // [danger #21] Render proof: the moment the card exists on this device,
    // tell the server — a timeout WITHOUT this stamp is UNDELIVERABLE and
    // never decays the acceptance rate. Fire-and-forget garnish.
    const markSeen = (orderId: string, offerAttemptId?: string) => { void api.offerSeen(orderId, offerAttemptId).catch(() => {}); };
    const onOffer = (data: DispatchOffer) => {
      setOffer(data);
      markSeen(data.orderId, data.offerAttemptId);
      qc.invalidateQueries({ queryKey: ['mover', 'available', kind] });
    };
    s.on('dispatch:offer', onOffer);

    // [E27 / danger #37] Offer RECOVERY: a socket that dropped while the ping
    // was in flight used to lose the card forever (and the silent timeout
    // still counted against acceptance). On mount and every reconnect, ask
    // the server for the live exclusive offer and rebuild the card with its
    // REAL remaining seconds. Failures are garnish — the poll fallback and
    // the next socket ping still stand.
    let gone = false;
    const recover = async () => {
      try {
        const data = await unwrap<{ offer: RecoveredDispatchOffer | null }>(api.currentOffer());
        if (!gone && data?.offer?.orderId) {
          const recoveredOffer: DispatchOffer = {
            ...data.offer,
            offerAttemptId: data.offer.offerAttemptId ?? undefined,
          };
          setOffer(recoveredOffer);
          markSeen(recoveredOffer.orderId, recoveredOffer.offerAttemptId);
          qc.invalidateQueries({ queryKey: ['mover', 'available', kind] });
        }
      } catch { /* recovery only — never surface */ }
    };
    void recover();
    s.on('connect', recover);
    return () => {
      gone = true;
      s.off('dispatch:offer', onOffer);
      s.off('connect', recover);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, online, qc, pv]);

  // Auto-dismiss once the offer window lapses (the backend reassigns it).
  // Keyed to the ABSOLUTE deadline stamped at arrival, and it drops THAT
  // order, not whatever sits at the head by then — with a queue the two can
  // differ. A timer that fires late after backgrounding still computes a
  // non-negative remainder, so a lapsed card cannot linger (G11).
  useEffect(() => {
    if (!offer) return;
    const deadline = offer.deadlineAt ?? (offer.expiresInSeconds ? Date.now() + offer.expiresInSeconds * 1000 : null);
    if (!deadline) return;
    const { orderId } = offer;
    const t = setTimeout(() => dropOffer(orderId), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.orderId]);

  return {
    offer,
    // Stacking: how many more offers wait behind the visible card — the UI
    // states queue depth honestly, like the vendor takeover does.
    queuedBehind,
    dismiss: () => { if (offer) dropOffer(offer.orderId); },
  };
}
