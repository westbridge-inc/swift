import type { Metadata } from 'next';
import './globals.css';
import { swiftDesignVariables } from '@/lib/design-tokens';
import { site, launch, SITE_ORIGIN } from '@/site.config';

/**
 * [SITE-1.1 Part 5] `metadataBase` is what makes every canonical URL and every
 * Open Graph image resolve to an absolute address on the apex host. Without it
 * Next emits relative OG URLs, which most crawlers and every link-preview
 * renderer silently drop.
 *
 * The description states the market truthfully rather than claiming a region —
 * an availability claim on the company site is the first thing a reviewer can
 * check against reality.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: 'Swift — food, groceries, shops, couriers and rides',
    template: '%s — Swift',
  },
  description: `One app for food and grocery delivery, local shops, taxi rides, parcels and trades in ${launch.markets[0]}. Businesses and movers keep 100% of what they earn — one flat weekly fee, no commission.`,
  applicationName: 'Swift',
  alternates: { canonical: SITE_ORIGIN },
  openGraph: {
    type: 'website',
    siteName: 'Swift',
    locale: 'en_GY',
    url: SITE_ORIGIN,
    title: 'Swift — food, groceries, shops, couriers and rides',
    description: `Order in ${launch.markets[0]}. The people doing the work keep 100% of what they earn.`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Swift',
    description: `One app for ${launch.markets[0]}. Zero commission — ever.`,
  },
  robots: { index: true, follow: true },
  // IDENTITY LAW [SITE-1.1 Part 2]: the company is the author, never a person.
  authors: [{ name: site.legalEntityName }],
  creator: site.legalEntityName,
  publisher: site.legalEntityName,
  formatDetection: { telephone: false, address: false, email: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GY" style={swiftDesignVariables}>
      <body>{children}</body>
    </html>
  );
}
