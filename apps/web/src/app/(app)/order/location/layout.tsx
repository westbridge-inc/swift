import type { Metadata } from 'next';

/**
 * [DS273 F3] Saved delivery addresses are one person's data — signed-in-only by
 * the customer shell. Nothing here is public content, so search engines must
 * never index it.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function OrderLocationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
