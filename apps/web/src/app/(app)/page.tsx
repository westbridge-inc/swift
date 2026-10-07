import { fetchGuestHome } from '@/lib/browse-server';
import { HomeScreen } from './home-screen';

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
/**
 * [W2] The page arrives with the stores in it. The server reads the GUEST Home
 * feed (no cookie, no person — lib/browse-server.ts) and hands it to the page as
 * Home's first answer, so a phone on a slow line sees the stores before
 * any script has run; the browser re-reads it only once it is a minute old.
 * The page itself is rebuilt at most once a minute (ISR), never per visitor.
 */
export const revalidate = 60;

export default async function HomePage() {
  return <HomeScreen seed={await fetchGuestHome()} />;
}
