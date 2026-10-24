'use client';

import { useQuery } from '@tanstack/react-query';
import { DataUnavailable } from '@/components/data-unavailable';
import { PartnerDocuments } from '@/components/partner-documents';
import { getStores } from '@/lib/vendor-api';
import { useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';

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
  // The checklist is read and filed for the signed-in person, so only the
  // store's owner sends its documents; a manager or staff login is told so
  // instead of being shown an empty checklist of their own.
  const { role, known, failed } = useStoreRole();

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="sw-title">Documents</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          What Swift checks before your store goes live, and where each document stands. If one is turned down, you
          see why and send a new copy of that one only. We review documents Monday to Saturday, 8:00–20:00 Guyana time.
        </p>
      </div>
      {stores.isError || failed ? (
        <DataUnavailable what="your store" error={stores.error} onRetry={() => void stores.refetch()} />
      ) : !store || !known ? (
        <p role="status" className="text-sm text-[var(--swift-muted)]">Loading your documents…</p>
      ) : role !== 'OWNER' ? (
        <p role="status" className="sw-card p-6 text-sm">Only the store’s owner sends its documents. Ask the owner to sign in to see where each one stands.</p>
      ) : (
        <PartnerDocuments role={store.vendorType} helpTopic="VENDOR" />
      )}
    </div>
  );
}
