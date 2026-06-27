import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Swift Admin Dashboard',
  description: 'Admin dashboard for the Swift delivery platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0A0A0A] text-white min-h-screen">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
