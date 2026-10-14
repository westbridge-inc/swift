import type { Metadata } from 'next';

/**
 * [W4] The checkout is one person's basket and order: no public content, so
 * search engines must never index it (the same rule as the cart).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children;
}
