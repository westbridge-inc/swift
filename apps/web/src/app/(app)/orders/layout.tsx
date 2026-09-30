import type { Metadata } from 'next';

/**
 * [DS273 F3] The order list and every order detail / tracking page under it
 * belong to one account — signed-in-only by the customer shell. Nothing here
 * is public content, so search engines must never index it.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
