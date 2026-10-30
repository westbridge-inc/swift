'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hasProviderProfile } from '@/lib/auth';
import { getProviderFee } from '@/lib/provider-fee-api';

/**
 * [REVIEW-F #2238 S4-1] The partner office's Earnings and History are a mover's. A pro with no delivery or taxi profile
 * (who may sign in to pay their own weekly fee) is told what the pages are for and where their fee is, never "start
 * driving or delivering". Anyone else keeps the page's own words (`children`).
 */
export function NoEarnerProfile({ children }: { children: ReactNode }) {
  const pro = useQuery({ queryKey: ['provider-fee'], queryFn: getProviderFee });
  if (pro.isLoading) return null;
  if (!pro.data) return <>{children}</>;
  return (
    <p className="rounded-2xl border border-dashed border-[var(--swift-border)] bg-[var(--swift-card)] p-10 text-center text-sm text-[var(--swift-muted)]">
      Earnings and history here are for deliveries and taxi rides. As a service provider you take jobs in the Swift app.{' '}
      <Link href="/portal/weekly-fee" className="font-semibold underline">Your weekly fee</Link>
    </p>
  );
}

/** [REVIEW-M #2238 S4-2] A store owner who is also a pro: their own pro fee, one link from the store's weekly fee. */
export function ProviderFeeLink() {
  const pro = useQuery({ queryKey: ['has-provider'], queryFn: hasProviderProfile });
  if (!pro.data) return null;
  return <p className="mt-6 text-sm print:hidden"><Link href="/portal/weekly-fee" className="underline">Your service provider weekly fee</Link></p>;
}
