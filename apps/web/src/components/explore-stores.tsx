'use client';

import { useQuery } from '@tanstack/react-query';
import { getVendors } from '@/lib/customer';
import { useCustomerSession } from './customer-session';
import { VendorCard, VendorGridSkeleton } from './order-ui';

/** Only the live rail hydrates; Explore's static content stays on the server. */
export function ExploreStores() {
  const { status, scope, epoch } = useCustomerSession();
  const vendors = useQuery({
    queryKey: ['customer', 'explore', status, scope, epoch], queryFn: () => getVendors(),
    staleTime: 5_000, enabled: status !== 'checking',
  });
  return <div className="mt-4">{vendors.isPending ? <VendorGridSkeleton />
    : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{(vendors.data ?? []).slice(0, 8).map((v) => <VendorCard key={v.id} v={v} />)}</div>}
  </div>;
}
