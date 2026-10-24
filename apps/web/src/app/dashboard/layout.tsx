import type { Metadata } from 'next';
import { DashboardShell } from './dashboard-shell';
import { LegalAcceptanceGate } from '@/components/legal-acceptance-gate';

/**
 * [DS273 F3] The vendor console (today, orders, inventory, import, settings) is
 * one business's private back office — signed-in-only by DashboardShell. It
 * carries no public content, so search engines must never index it. The chrome
 * itself is a client component (dashboard-shell.tsx); this server layout is
 * where the page's `noindex` rule lives.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // [Legal research G2 · R26] a material change to the Terms is accepted with a fresh tick
  return <><DashboardShell>{children}</DashboardShell><LegalAcceptanceGate /></>;
}
