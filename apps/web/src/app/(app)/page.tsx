import { CustomerHome } from '@/components/customer-home';
import { SiteFooter } from '@/components/site';
import { launch } from '@/site.config';

/**
 * [Q7b] swiftgy.com opens straight into ordering — the customer app's Home,
 * inside the app shell, the way the phone app opens. The introduction that
 * used to live here is at /welcome.
 *
 * What `/` still owes the site, and where each duty now lives:
 *   - SEO: this page carries the root layout's metadata unchanged — the title,
 *     description, canonical https://swiftgy.com and Open Graph card — and the
 *     sitemap still lists `/` first. The heading, the services and their links
 *     are server-rendered, so a crawler reads a real page, not a spinner.
 *   - The legal duties: the site footer below (privacy, terms, child safety,
 *     account deletion, the support inbox and the operating company's name) —
 *     the same footer every marketing page carries.
 *   - Store badges: none, still gated by showAppStoreBadges in site.config.
 */
export default function HomePage() {
  return (
    <>
      <CustomerHome market={launch.markets[0]} />
      <div className="-mx-4 mt-12 overflow-hidden md:mx-0 md:rounded-3xl">
        <SiteFooter />
      </div>
    </>
  );
}
