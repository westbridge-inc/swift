import type { Metadata } from 'next';

/**
 * [DS273 F3] The cart is one person's basket and checkout rail — signed-in-only
 * by the customer shell. It carries no public content, so search engines must
 * never index it. robots.txt is only a crawler hint; this `noindex` is the
 * page's own rule.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
