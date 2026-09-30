'use client';

import { useQuery } from '@tanstack/react-query';
import { getStores } from '@/lib/vendor-api';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { DocumentChecklist, ServiceProviderDocuments } from './document-checklist';

export function StoreDocuments() {
  const storeId = useStoreId();
  const stores = useQuery({ queryKey: storeKey(storeId, 'document-store'), queryFn: getStores });
  const store = stores.data?.stores.find((item) => item.id === (storeId ?? stores.data?.selectedId));
  return <div id="documents" className="space-y-3">
    {stores.isError ? <div role="alert"><p>Could not load your store’s document requirements.</p><button type="button" className="min-h-11 underline" onClick={() => void stores.refetch()}>Try documents again</button></div>
      : store && stores.data?.myRole !== 'OWNER' ? <p>The store owner manages the required documents in their Swift account.</p>
      : store ? <DocumentChecklist key={store.id} role={store.vendorType} />
      : <p role="status">Select your store to see its required documents.</p>}
    <ServiceProviderDocuments />
  </div>;
}
