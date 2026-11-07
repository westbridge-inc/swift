'use client';

import { useQuery } from '@tanstack/react-query';
import { getStores, type Store } from '@/lib/vendor-api';
import { useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { DataUnavailable } from '@/components/data-unavailable';
import { STORE_DOCUMENT_ROLES } from '@/lib/store-documents';
import { StoreDocumentChecklist } from './checklist';

/**
 * [OPEN-EARLY PR-2 · owner 31 Oct 2026] The store's documents, on the website: the phone's Account → Documents
 * (VendorAccountScreen VendorDocumentsSection), for the store picked in the sidebar. OWNER only, as the phone
 * (`isOwner && store.vendorType`): a manager or staff login is told whose they are and sees nothing else. Another
 * store of the owner shows its own list when it is picked (the store switcher), as on the phone.
 */
export default function DocumentsPage() {
  const storeId = useStoreId();
  const { role, known, failed } = useStoreRole();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const store: Store | undefined = (stores.data?.stores ?? []).find((s) => s.id === storeId);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="sw-title">Documents</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          {store ? `${store.name}: the documents Swift needs before it goes live, and where each one stands.` : 'The documents Swift needs before your store goes live, and where each one stands.'}
        </p>
      </div>
      {failed || stores.isError ? (
        <DataUnavailable what="who can see this store's documents" error={stores.error} onRetry={() => void stores.refetch()} />
      ) : !known || !stores.data ? (
        <p role="status" className="text-sm text-[var(--swift-muted)]">Loading…</p>
      ) : role !== 'OWNER' ? (
        <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">A store&apos;s documents are its owner&apos;s: only the owner can see and upload them.</p>
      ) : store && STORE_DOCUMENT_ROLES.has(store.vendorType) ? (
        <StoreDocumentChecklist storeId={store.id} vendorType={store.vendorType} storeName={store.name} />
      ) : (
        <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">Choose a store in the menu to see its documents.</p>
      )}
    </div>
  );
}
