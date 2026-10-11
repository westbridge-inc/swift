import type { Metadata } from 'next';

/**
 * [W11] A customer's requests to local pros belong to one account —
 * signed-in-only by the customer shell. Search engines must never index them.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ServiceRequestsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
