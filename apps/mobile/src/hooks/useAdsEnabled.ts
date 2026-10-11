import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

/** Public server truth: no persisted opt-in, and a failed refresh closes entry. */
export function useAdsEnabled(): boolean {
  const capability = useQuery({
    queryKey: ['public', 'capabilities'],
    queryFn: async () => {
      const response = await api.get('/public/capabilities');
      return response.data?.success === true && response.data?.data?.adsEnabled === true;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30_000,
    retry: false,
  });
  return capability.isFetchedAfterMount && !capability.isError && capability.data === true;
}
