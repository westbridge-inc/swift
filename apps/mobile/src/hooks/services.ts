import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { servicesApi } from '../services/api';

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

export function useServiceJobs<T = any>() {
  return useQuery<T>({ queryKey: ['services', 'jobs'], queryFn: () => unwrap<T>(servicesApi.jobs()) });
}

export function useRequestJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { providerId: string; description: string; photos?: string[] }) =>
      unwrap(servicesApi.requestJob(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
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
