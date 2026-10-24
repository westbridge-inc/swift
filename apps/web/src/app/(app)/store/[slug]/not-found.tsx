import { QrState } from '@/components/qr-state/qr-state';

export default function StorefrontNotFound() {
  return (
    <QrState embedded eyebrow="Store not found" title="This store page is not available">
      The link may be old, or this store may no longer be listed on Swift. Nothing has been ordered or charged.
    </QrState>
  );
}
