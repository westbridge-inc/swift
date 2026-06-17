import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { riderApi, driverApi } from '../services/api';

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
  return useMutation({ mutationFn: (id: string) => unwrap(svc(kind).accept(id)), onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }) });
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
