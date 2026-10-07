'use client';

import { useQuery } from '@tanstack/react-query';
import { useCustomerSession } from '@/components/customer-session';

/**
 * One account read, keyed to the person (and never cached as fresh), shared by
 * every page that shows it — Account's own pages and a store's heart [W6].
 */
export function useAccountQuery<T>(name: string, read: () => Promise<T>) {
  const session = useCustomerSession();
  return useQuery({ queryKey: ['account', session.scope, session.epoch, name], queryFn: read,
    enabled: session.status === 'signed-in', retry: false, staleTime: 0, gcTime: 0 });
}
