'use client';

import Link from 'next/link';
import { useWebOrderingOpen } from '@/lib/use-web-ordering';
import { launchCity } from '@/lib/web-ordering';

/**
 * [AC-10 · Item 7] The welcome page's primary action promises only what works
 * on this site today: "Order on the web" where ordering is open, and a plain
 * launch note — not a button dressed as one — where it is not yet.
 */
export function OrderOnTheWeb({ className }: { className: string }) {
  const open = useWebOrderingOpen();
  if (open) {
    return (
      <Link href="/" className={className}>
        Order on the web
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--swift-subtle)] px-6 py-3 font-semibold text-[var(--swift-ink)]">
      Launching soon in {launchCity}
    </span>
  );
}
