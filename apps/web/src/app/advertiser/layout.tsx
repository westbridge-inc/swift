import type { Metadata } from 'next';
import { AdvertiserShell } from './shell';
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) { return <AdvertiserShell>{children}</AdvertiserShell>; }
