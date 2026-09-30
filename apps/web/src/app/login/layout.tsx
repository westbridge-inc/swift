import type { Metadata } from 'next';

// Authentication and return-to-account flow; not public search content.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
