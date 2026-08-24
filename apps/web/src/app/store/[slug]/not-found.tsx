import { QrState } from '@/components/qr-state/qr-state';

export default function StorefrontNotFound() {
  return (
    <QrState eyebrow="Store not found" title="This store page is not available">
      The link may be old, or the store may no longer be public. Nothing has been ordered or charged.
    </QrState>
  );
}
