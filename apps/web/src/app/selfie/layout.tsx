import type { Metadata } from 'next';

/**
 * [DS273 F3] The verification selfie page is signed-in-only: a guest is sent to
 * /login before it loads. It is one person's identity step, never public
 * content, so search engines must never index it.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SelfieLayout({ children }: { children: React.ReactNode }) {
  return children;
}
