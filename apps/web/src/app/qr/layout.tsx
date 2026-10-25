import type { Metadata } from 'next';

// QR lifecycle status pages are utility screens, not public store content.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function QrLayout({ children }: { children: React.ReactNode }) {
  return children;
}
