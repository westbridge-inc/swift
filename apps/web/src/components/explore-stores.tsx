'use client';

import { useEffect, useState } from 'react';
import { getVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton } from './order-ui';

/** Only the live rail hydrates; Explore's static content stays on the server. */
export function ExploreStores() {
  const [featured, setFeatured] = useState<Vendor[] | null>(null);
  useEffect(() => {
    let alive = true;
    getVendors().then((vendors) => { if (alive) setFeatured(vendors.slice(0, 8)); })
      .catch(() => { if (alive) setFeatured([]); });
    return () => { alive = false; };
  }, []);
  return <div className="mt-4">{featured === null ? <VendorGridSkeleton />
    : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{featured.map((v) => <VendorCard key={v.id} v={v} />)}</div>}
  </div>;
}
