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
