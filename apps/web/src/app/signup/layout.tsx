import type { Metadata } from 'next';

// [WEB-ONBOARDING · FLOW-QA F25] The sign-up page's own title in the tab and in search results (it showed the site's
// default). It stays a public, indexable door (private-routes-noindex.test.ts), so this sets no indexing rule.
export const metadata: Metadata = {
  title: 'Sign up',
  description: 'Put your business on Swift, deliver with Swift or drive a taxi with Swift.',
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
