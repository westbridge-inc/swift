import type { Metadata, Viewport } from 'next';
import './globals.css';
import { appChrome, swiftDesignVariables } from '@/lib/design-tokens';
import { ServiceWorkerRegistrar } from '@/components/service-worker-registrar';
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
  // [PWA-1] The installed app (manifest.ts carries the rest). iOS reads its
  // home-screen icon and title from these tags, not from the manifest's icons.
  // 'default' keeps the status bar solid with dark text above the customer
  // shell's white header; 'black-translucent' would lay white status text over it.
  appleWebApp: { capable: true, title: 'Swift', statusBarStyle: 'default' },
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  // Next emits only the standard `mobile-web-app-capable` for `capable`; the
  // Apple-prefixed name is what older iOS releases look for.
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

/**
 * [PWA-1] `viewport-fit=cover` lets the installed app use the whole screen on a
 * notched iPhone — and makes `env(safe-area-inset-*)` report real values, which
 * the body (sides) and the customer shell (header, bottom) then pad by, so
 * nothing sits under the notch or the home bar. Zoom stays enabled.
 */
export const viewport: Viewport = {
  themeColor: appChrome.theme,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GY" style={swiftDesignVariables}>
      <body>
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
