import type { Metadata } from 'next';

/**
 * [DS273 F3] Profile / account is one person's name, phone and links into
 * their orders and addresses — signed-in-only by the customer shell. It
 * carries no public content, so search engines must never index it.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
