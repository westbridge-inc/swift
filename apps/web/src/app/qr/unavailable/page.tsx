import { QrState } from '@/components/qr-state/qr-state';

export default function UnavailableQrPage() {
  return (
    <QrState eyebrow="Store unavailable" title="This store is not available from this code">
      The store may be offline or no longer public. Nothing has been ordered or charged. Try again later or browse another store.
    </QrState>
  );
}
