import { SiteNav, SiteFooter } from '@/components/site';

/** Legal pages carry the full site chrome: a reviewer landing on /legal/privacy
 *  from a store listing must be able to reach the rest of the company site. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--swift-canvas)]">
      <SiteNav />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
