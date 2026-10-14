import { SiteFooter } from '@/components/site';

/**
 * [Q36] A store page is where a customer decides to buy, so it carries the
 * same company footer as every marketing and legal page: who operates Swift,
 * the policies, and how money moves. The storefront itself is unchanged; the
 * footer sits below it, and below its loading, error and not-found states.
 *
 * [W6] The store's one page now sits inside the customer app's frame (rail and
 * dock), so the footer spans the page column, edge to edge.
 */
export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <div className="-mx-6 mt-12 wide:-mx-10">
        <SiteFooter />
      </div>
    </>
  );
}
