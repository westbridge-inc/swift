import { SiteNav, SiteFooter } from '@/components/site';

// Marketing chrome lives on the (marketing) group only — the vendor dashboard
// is an app, not a brochure.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
