import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import type { PartnerPricing } from '../lib/partnerPricing';

/** Public weekly price list for the partner pitch ("N days free, then X/week").
 *  Read a partner's own quote from it with `moverQuote` / `vendorQuote`. Its
 *  own module, so the earner and business hooks that bill a preview sample at
 *  the live quote depend on nothing else in the verification hooks. */
export function usePartnerPricing(countryCode?: string, enabled = true) {
  return useQuery({
    queryKey: ['pricing', countryCode ?? 'GY'],
    queryFn: async () => (await authApi.pricing(countryCode))?.data?.data as PartnerPricing,
    staleTime: 60 * 60 * 1000,
    enabled,
  });
}
