import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

/**
 * [PERF #10] How often an open app re-asks whether ads are on. While they are
 * ON the answer is the ads kill switch, so it is re-read every 30 s exactly as
 * before: switching ads off hides them within 30 s. While they are OFF (the
 * launch state) nothing is shown, and switching them on is never urgent, so
 * the app asks every 5 minutes instead of every 30 s.
 */
export const ADS_ON_RECHECK_MS = 30_000;
export const ADS_OFF_RECHECK_MS = 5 * 60_000;

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
    refetchInterval: (query) => (query.state.data === true ? ADS_ON_RECHECK_MS : ADS_OFF_RECHECK_MS),
    retry: false,
  });
  return capability.isFetchedAfterMount && !capability.isError && capability.data === true;
}
