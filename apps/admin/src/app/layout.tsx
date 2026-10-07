import type { Metadata } from 'next';
import { Bricolage_Grotesque, Hanken_Grotesk } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Swift Admin Dashboard',
  description: 'Admin dashboard for the Swift delivery platform',
};

// [MISSION CONTROL · PR-1] The design's type: Hanken Grotesk for body, Bricolage
// Grotesque for numbers and names. next/font fetches them at BUILD time and
// serves them from this origin, so no browser request goes to a font CDN and
// the CSP stays `font-src 'self'`. Exposed as CSS variables; the Mission
// Control sheet (globals.css, --mc-font-*) is what uses them.
const body = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-mc-body', display: 'swap' });
const numbers = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-mc-numbers', display: 'swap' });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${body.variable} ${numbers.variable}`}>
      <body className="bg-[var(--ink)] text-white min-h-screen">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
