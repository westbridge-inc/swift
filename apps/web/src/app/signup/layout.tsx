import type { Metadata } from 'next';

// Personal identity and registration flow; not public search content.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
