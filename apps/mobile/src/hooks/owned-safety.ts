import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { safetyApi } from '../services/api';
import { requireAuthSessionForPrincipal, useAuthStore } from '../stores/authStore';
import type { AuthPrincipalBoundary } from '../lib/authSession';
import type { SosRaised } from './safety';

export interface OwnedSosAlert extends SosRaised {
  actorUserId: string;
  userSafeFlaggedAt: string | null;
  orderId: string | null;
  serviceJobId: string | null;
  triggeredAt: string;
}
const statuses = ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'];
export function ownedSosResult(value: unknown, owner: AuthPrincipalBoundary, id?: string): OwnedSosAlert {
  const row = value as OwnedSosAlert | null;
  if (!row || row.actorUserId !== owner.userId || typeof row.id !== 'string' || (id && row.id !== id) || !statuses.includes(row.status)
    || (row.userSafeFlaggedAt !== null && (typeof row.userSafeFlaggedAt !== 'string' || !Number.isFinite(Date.parse(row.userSafeFlaggedAt))))) {
    throw new Error('Could not verify your safety alert. Refresh to try again.');
  }
  return row;
}
function useSafetyOwner() {
  const user = useAuthStore((s) => s.user);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return { owner: { userId: user?.id ?? '', generation: sessionGeneration }, enabled: isAuthenticated && !!user?.id };
}
export function useMonitoringPreference() {
  const { owner, enabled } = useSafetyOwner();
  const query = useQuery({
    queryKey: ['safety', 'monitoring', owner.userId, owner.generation], enabled,
    queryFn: async () => {
      const res = await safetyApi.monitoringPreference(requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      const value: unknown = res.data?.data?.enhancedSafetyMonitoring;
      if (typeof value !== 'boolean') throw new Error('Could not read your saved setting.');
      return value;
    },
  });
  const save = useMutation({
    mutationFn: async (value: boolean) => {
      await safetyApi.setMonitoringPreference(value, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      const refreshed = await query.refetch({ throwOnError: true });
      requireAuthSessionForPrincipal(owner);
      if (typeof refreshed.data !== 'boolean') throw new Error('Could not verify the saved setting.');
      return refreshed.data;
    }, meta: { silent: true },
  });
  return { query, save, owner };
}
export function useOwnedSosAlerts() {
  const { owner, enabled } = useSafetyOwner();
  return useInfiniteQuery({
    queryKey: ['safety', 'owned-active', owner.userId, owner.generation], enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const res = await safetyApi.ownedActiveSos(pageParam, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      if (!Array.isArray(res.data?.data)) throw new Error('Could not read your safety alerts.');
      const rows = res.data.data.map((row: unknown) => ownedSosResult(row, owner));
      const cursor: unknown = res.data.nextCursor;
      if (cursor !== null && typeof cursor !== 'string') throw new Error('Could not continue your safety alerts.');
      return { rows, nextCursor: cursor as string | null };
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
}
export function useOwnedSosAlert(id: string) {
  const { owner, enabled } = useSafetyOwner();
  return useQuery({
    queryKey: ['safety', 'owned-alert', owner.userId, owner.generation, id], enabled: enabled && !!id,
    queryFn: async () => {
      const res = await safetyApi.getSos(id, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      return ownedSosResult(res.data?.data, owner, id);
    }, refetchInterval: 5_000,
  });
}
export function useMarkSafeSos() {
  const { owner } = useSafetyOwner();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Read the current owned alert before every write, including retries.
      const res = await safetyApi.getSos(id, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      const row = ownedSosResult(res.data?.data, owner, id);
      if (row.status !== 'ACTIVE' && row.status !== 'ACKNOWLEDGED' && !row.userSafeFlaggedAt) return row;
      await safetyApi.markSafeSos(id, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      const refreshed = await safetyApi.getSos(id, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      const saved = ownedSosResult(refreshed.data?.data, owner, id);
      if ((saved.status === 'ACTIVE' || saved.status === 'ACKNOWLEDGED') && !saved.userSafeFlaggedAt) throw new Error('Could not verify your safe flag.');
      return saved;
    },
    onSettled: () => {
      // Refresh failures remain visible to the caller; invalidation does not
      // turn a transport failure into a successful mark-safe acknowledgement.
      void qc.invalidateQueries({ queryKey: ['safety'] });
    }, meta: { silent: true },
  });
}
