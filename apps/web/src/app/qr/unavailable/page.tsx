import { QrState } from '@/components/qr-state/qr-state';

export default function UnavailableQrPage() {
  return (
    <QrState eyebrow="Store unavailable" title="This store is not available from this code">
      This store isn’t taking orders right now. Nothing has been ordered or charged. Try again later or browse another store.
    </QrState>
  );
}
