import type { Metadata } from 'next';
import './globals.css';
import { SiteNav, SiteFooter } from '@/components/site';

export const metadata: Metadata = {
  title: {
    default: 'Swift — food, groceries, shops, couriers and rides',
    template: '%s — Swift',
  },
  description:
    'The Caribbean super-app. Order food and groceries, send parcels, book rides. Businesses and drivers keep 100% of what they earn — one flat weekly fee, no commission.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
