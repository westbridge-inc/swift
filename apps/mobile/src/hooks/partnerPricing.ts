import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import type { PartnerPricing } from '../lib/partnerPricing';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Public weekly price list for the partner pitch ("N days free, then X/week").
 *  Read a partner's own quote from it with `moverQuote` / `vendorQuote`. Its
 *  own module, so the earner and business hooks that bill a preview sample at
 *  the live quote depend on nothing else in the verification hooks.
 *
 *  `fresh` is for the signup screens [PR1270-S2-04]: a preview sample may read
 *  an hour-old list, but a partner about to agree to a weekly fee reads one
 *  fetched on this mount and refreshed every minute the screen stays open, so
 *  the fee on the door is the fee today — never a figure cached an hour ago
 *  and changed since. */
export function usePartnerPricing(countryCode?: string, enabled = true, opts?: { fresh?: boolean }) {
  const fresh = opts?.fresh === true;
  return useQuery({
    queryKey: ['pricing', countryCode ?? 'GY'],
    queryFn: async () => (await authApi.pricing(countryCode))?.data?.data as PartnerPricing,
    staleTime: fresh ? 0 : HOUR_MS,
    refetchOnMount: fresh ? 'always' : true,
    refetchInterval: fresh ? MINUTE_MS : false,
    enabled,
  });
}
