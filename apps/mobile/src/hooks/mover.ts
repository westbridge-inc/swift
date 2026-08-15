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
  const m = useMutation({ mutationFn: ({ orderId, fare }: { orderId: string; fare?: number }) => unwrap(svc(kind).acceptOffer(orderId, fare)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
  return pv ? PV.previewMutation() : m;
}
/** Explicit pass on a dispatch offer — tells the cascade to move to the next
 *  mover NOW instead of letting the 20s timeout burn. Best-effort: if the
 *  offer already expired server-side the decline 409s, which is fine. */
export function useDeclineOffer(kind: MoverKind) {
  const pv = usePreview();
  const m = useMutation({
    mutationFn: (orderId: string) => svc(kind).declineOffer(orderId).catch(() => null),
    onSuccess: () => track('offer_declined', { kind }),
  });
  return pv ? PV.previewMutation() : m;
}
export function useDriverAction() {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ id, action, pin }: { id: string; action: 'en-route' | 'arrived' | 'verify-pin' | 'start' | 'complete'; pin?: string }) => {
      if (action === 'en-route') return unwrap(driverApi.enRoute(id));
      if (action === 'arrived') return unwrap(driverApi.arrived(id));
      if (action === 'verify-pin') return unwrap(driverApi.verifyPin(id, pin ?? ''));
      if (action === 'start') return unwrap(driverApi.start(id));
      return unwrap(driverApi.complete(id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
  });
  return pv ? PV.previewMutation() : m;
}
export type RiderAction =
  | 'en-route-pickup' | 'arrived-pickup' | 'picked-up' | 'en-route-delivery' | 'arrived'
  | 'handover' | 'delivered';

export function useRiderAction() {
  const pv = usePreview();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: RiderAction }) => {
      switch (action) {
        case 'en-route-pickup': return unwrap(riderApi.enRoutePickup(id));
        case 'arrived-pickup': return unwrap(riderApi.arrivedPickup(id));
        case 'picked-up': return unwrap(riderApi.pickedUp(id));
        case 'en-route-delivery': return unwrap(riderApi.enRouteDelivery(id));
        case 'arrived': return unwrap(riderApi.arrivedAtCustomer(id));
        case 'delivered': return unwrap(riderApi.delivered(id));
        case 'handover': {
          const owner = requireAuthSessionSnapshot();
          // The golden-rule handover NEEDS the rider's GPS (server-side mandatory —
          // it's the evidence a guarantee claim stands on). Last-known is instant;
          // fall back to a fresh fix.
          let pos = await Location.getLastKnownPositionAsync().catch(() => null);
          let current = requireAuthSessionForPrincipal(owner);
          if (!pos) {
            pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            current = requireAuthSessionForPrincipal(owner);
          }
          const result = await unwrap(riderApi.handover(
            id,
            { outcome: 'paid', gps: { lat: pos.coords.latitude, lng: pos.coords.longitude } },
            current,
          ));
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

export interface DispatchOffer {
  orderId: string;
  orderNumber?: string;
  vendorName?: string;
  expiresInSeconds?: number;
  etaMinutes?: number;
  // [REPORT-010 F-07] Authoritative money/route facts carried by the RECOVERY
  // payload so a rebuilt card never prices itself from a missing board row.
  deliveryFee?: number;
  tipAmount?: number;
  taxiFareTotal?: number | null;
  pickupAddress?: string | null;
  deliveryAddress?: string | null;
}

/**
 * Real-time dispatch offers. The backend emits `dispatch:offer` to the mover's
 * user room the moment they're the top candidate; we surface it instantly and
 * refresh the available list. Polling (useAvailableJobs) stays as a fallback,
 * so a missed socket event still resolves within the poll interval.
 */
export function useDispatchOffers(kind: MoverKind | null, online: boolean) {
  const pv = usePreview();
  const qc = useQueryClient();
  const [offer, setOffer] = useState<DispatchOffer | null>(null);

  useEffect(() => {
    // No live offers in preview (read-only, no socket/auth).
    if (!kind || !online || pv) {
      setOffer(null);
      return;
    }
    connectSocket();
    const s = getSocket();
    const api = kind === 'DRIVER' ? driverApi : riderApi;
    // [danger #21] Render proof: the moment the card exists on this device,
    // tell the server — a timeout WITHOUT this stamp is UNDELIVERABLE and
    // never decays the acceptance rate. Fire-and-forget garnish.
    const markSeen = (orderId: string) => { void api.offerSeen(orderId).catch(() => {}); };
    const onOffer = (data: DispatchOffer) => {
      setOffer(data);
      markSeen(data.orderId);
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
        const data = await unwrap<{ offer: DispatchOffer | null }>(api.currentOffer());
        if (!gone && data?.offer?.orderId) {
          setOffer(data.offer);
          markSeen(data.offer.orderId);
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
  }, [kind, online, qc, pv]);

  // Auto-dismiss once the offer window lapses (the backend reassigns it).
  useEffect(() => {
    if (!offer?.expiresInSeconds) return;
    const t = setTimeout(() => setOffer(null), offer.expiresInSeconds * 1000);
    return () => clearTimeout(t);
  }, [offer]);

  return { offer, dismiss: () => setOffer(null) };
}
