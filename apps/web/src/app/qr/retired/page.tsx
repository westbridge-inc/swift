import { QrState } from '@/components/qr-state/qr-state';
import { STORE_SLUG_RE } from '@/lib/store-slug';

export default async function RetiredQrPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const requestedStore = (await searchParams).store;
  const storeSlug = requestedStore && STORE_SLUG_RE.test(requestedStore) ? requestedStore : undefined;
  return (
    <QrState eyebrow="This counter code is no longer in use" title="This QR code has been replaced" storeSlug={storeSlug}>
      This printed code is no longer in use. Use the store’s current page or ask the business for its latest counter card.
    </QrState>
  );
}
