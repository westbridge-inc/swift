'use client';

import { useQuery } from '@tanstack/react-query';
import { DataUnavailable } from '@/components/data-unavailable';
import { PartnerDocuments } from '@/components/partner-documents';
import { getStores } from '@/lib/vendor-api';
import { useStoreId } from '@/lib/store-scope';

/**
 * [DOCS-1 · owner case] A store owner's documents on the web. Sign-up sends
 * them here ("finish verification in your dashboard") and the server's own
 * refusals say "check Documents" — this is that page. The checklist is the one
 * for the chosen store's kind (a restaurant's differs from a shop's), read from
 * the same API the phone app uses.
 */
export default function StoreDocumentsPage() {
  const storeId = useStoreId();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const store = stores.data?.stores.find((candidate) => candidate.id === storeId) ?? null;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">Documents</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          What Swift checks before your store goes live, and where each document stands. If one is turned down, you
          see why and send a new copy of that one only. Reviews usually finish within 24 hours.
        </p>
      </div>
      {stores.isError ? (
        <DataUnavailable what="your store" error={stores.error} onRetry={() => void stores.refetch()} />
      ) : !store ? (
        <p role="status" className="text-sm text-[var(--swift-muted)]">Loading your documents…</p>
      ) : (
        <PartnerDocuments role={store.vendorType} helpTopic="VENDOR" />
      )}
    </div>
  );
}
