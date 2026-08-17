import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { servicesApi } from '../services/api';
import { track } from '../lib/analytics';
import { unwrapOptionalServiceProviderProfile } from '../lib/serviceProviderProfile';
import {
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useServiceProviders<T = any>(trade?: string) {
  return useQuery<T>({
    queryKey: ['services', 'providers', trade],
    queryFn: () => unwrap<T>(servicesApi.providers(trade as string)),
    enabled: !!trade,
  });
}

/** A 404 is the valid "start onboarding" state. Auth, network, and 5xx
 * failures remain visible errors so the app never invents an empty profile. */
export function useServiceProviderProfile<T = any>() {
  const userId = useAuthStore((state) => state.user?.id);
  return useQuery<T | null>({
    queryKey: ['services', 'provider-me', userId],
    queryFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const provider = await unwrapOptionalServiceProviderProfile<T>(servicesApi.providerMe(owner));
      requireAuthSessionForPrincipal(owner);
      return provider;
    },
    enabled: !!userId,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * (2 ** attempt), 2_000),
    // Approval updates ServiceProvider.isVerified server-side. Poll only while
    // an existing profile is waiting so public-listability state catches up.
    refetchInterval: (query) => {
      const provider = query.state.data as { isVerified?: boolean } | null | undefined;
      return provider && !provider.isVerified ? 15_000 : false;
    },
  });
}

export function useSaveServiceProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { trade: string; bio?: string; portfolioPhotos?: string[] }) => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap(servicesApi.saveProvider(data, owner));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services', 'provider-me'] });
      void qc.invalidateQueries({ queryKey: ['services', 'providers'] });
      void qc.invalidateQueries({ queryKey: ['verification', 'SERVICE_PROVIDER'] });
    },
  });
}

export function useAddServiceQualification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      type: 'GEI_LICENCE' | 'CVQ' | 'GTEE' | 'CITY_AND_GUILDS' | 'OTHER';
      referenceNumber?: string;
    }) => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap(servicesApi.addQualification(data, owner));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['services', 'provider-me'] }),
  });
}

export function useServiceJobs<T = any>() {
  return useQuery<T>({ queryKey: ['services', 'jobs'], queryFn: () => unwrap<T>(servicesApi.jobs()) });
}

export function useRequestJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { providerId: string; description: string; photos?: string[] }) =>
      unwrap(servicesApi.requestJob(data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services', 'jobs'] });
      track('service_job_requested', {});
    },
  });
}

/** Accepting a quote = scheduling it (QUOTED → SCHEDULED, customer-only). */
export function useScheduleJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scheduledFor }: { id: string; scheduledFor: string }) =>
      unwrap(servicesApi.scheduleJob(id, scheduledFor)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(servicesApi.cancelJob(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useRateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, score, comment }: { id: string; score: number; comment?: string }) =>
      unwrap(servicesApi.rateJob(id, score, comment)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

// Provider side (§4.3): quote, then accept/decline the customer's slot.
export function useQuoteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) => unwrap(servicesApi.quoteJob(id, amount)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useConfirmJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(servicesApi.confirmJob(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useCompleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(servicesApi.completeJob(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useDeclineSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(servicesApi.declineSlot(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}
