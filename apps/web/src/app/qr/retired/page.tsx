import { QrState } from '@/components/qr-state/qr-state';

export default async function RetiredQrPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const requestedStore = (await searchParams).store;
  const storeSlug = requestedStore && /^[a-z0-9-]{1,60}$/.test(requestedStore) ? requestedStore : undefined;
  return (
    <QrState eyebrow="Counter code retired" title="This QR code has been replaced" storeSlug={storeSlug}>
      This printed code is no longer active. Use the store’s current page or ask the business for its latest counter card.
    </QrState>
  );
}
