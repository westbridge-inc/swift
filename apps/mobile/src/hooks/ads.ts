import { useQuery } from '@tanstack/react-query';
import { fetchAds, startAdEventLoop } from '../lib/ads';
import type { AdsResult } from '../lib/ads';

/**
 * One batched serve per home mount (ads spec §13.4): a single call feeds all
 * three placements. Home content NEVER waits on this — the screen renders and
 * the ad slots hydrate in. Failure/timeout falls back inside fetchAds (≤1 h
 * cache) and ultimately to null → the slots collapse and home closes up.
 */
export const AD_PLACEMENT_KEYS = ['home_hero_video', 'home_top_card', 'home_ad_bar'] as const;

export function useAds(city: string | undefined) {
  return useQuery<AdsResult>({
    queryKey: ['ads', 'serve', city ?? '*'],
    queryFn: () => {
      startAdEventLoop();
      return fetchAds(city ?? '*', [...AD_PLACEMENT_KEYS]);
    },
    staleTime: 5 * 60_000, // the serve ttl — week rollover stays ≤5 min stale (E10)
    gcTime: 60 * 60_000,
    retry: false, // fail silent — fetchAds already degrades to cache → collapse
    refetchOnWindowFocus: false,
  });
}
