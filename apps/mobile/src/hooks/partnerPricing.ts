import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import type { PartnerPricing } from '../lib/partnerPricing';

const MINUTE_MS = 60 * 1000;

/** Public weekly price list for the partner pitch ("N days free, then X/week").
 *  Read a partner's own quote from it with `moverQuote` / `vendorQuote`. Its
 *  own module, so the earner and business hooks that bill a preview sample at
 *  the live quote depend on nothing else in the verification hooks.
 *
 *  All prices refresh on mount under the app query policy. `fresh` keeps the
 *  signup screens' additional minute-by-minute refresh [PR1270-S2-04] while
 *  a partner is about to agree to the weekly fee. */
export function usePartnerPricing(countryCode?: string, enabled = true, opts?: { fresh?: boolean }) {
  const fresh = opts?.fresh === true;
  return useQuery({
    queryKey: ['pricing', countryCode ?? 'GY'],
    queryFn: async () => (await authApi.pricing(countryCode))?.data?.data as PartnerPricing,
    staleTime: 0,
    refetchOnMount: fresh ? 'always' : true,
    refetchInterval: fresh ? MINUTE_MS : false,
    enabled,
  });
}
