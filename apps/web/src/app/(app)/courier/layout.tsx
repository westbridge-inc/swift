import type { Metadata } from 'next';

/**
 * [DS273 F3] Sending a courier parcel is booked from one account — signed-in-only
 * by the customer shell. Nothing here is public content, so search engines must
 * never index it.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CourierLayout({ children }: { children: React.ReactNode }) {
  return children;
}
