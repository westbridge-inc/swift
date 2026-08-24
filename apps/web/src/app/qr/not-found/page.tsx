import { QrState } from '@/components/qr-state/qr-state';

export default function UnknownQrPage() {
  return (
    <QrState eyebrow="Code not found" title="Swift could not read this counter code">
      Check that the whole QR code is in view and scan it again. If the result is the same, ask the business for a current link.
    </QrState>
  );
}
