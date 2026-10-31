import type { Metadata } from 'next';
import { PortalShell } from './portal-shell';
import { LegalAcceptanceGate } from '@/components/legal-acceptance-gate';
import { LazyPrelaunchPartnerNote } from '@/components/prelaunch-partner-note-lazy';

/**
 * [DS273 F3] The earner portal (earnings, history, documents, account) is one
 * mover's private office — signed-in-only by PortalShell. It carries no public
 * content, so search engines must never index it. The chrome itself is a client
 * component (portal-shell.tsx); this server layout is where the page's `noindex`
 * rule lives.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  // [Legal research G2 · R26] a material change to the Terms is accepted with a fresh tick
  // [OPEN-EARLY] Before launch, every portal page (earnings, documents, ...) says approvals come on launch day.
  return <><PortalShell><LazyPrelaunchPartnerNote className="mb-5" />{children}</PortalShell><LegalAcceptanceGate /></>;
}
