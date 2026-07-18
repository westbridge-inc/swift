'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ShoppingBag, User, MapPin, Search } from 'lucide-react';
import { getToken } from '@/lib/auth';

// The customer ordering shell — everything under (app) requires a signed-in
// customer. Same localStorage token as the partner flow; a customer just lands
// on /order instead of /dashboard.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setReady(true);
  }, [router, pathname]);

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center text-[var(--swift-muted)]">Loading…</div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link href="/order" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--swift-red)] font-black text-white">S</span>
            <span className="text-lg font-extrabold">Swift</span>
          </Link>
          <Link href="/order/location" className="ml-2 hidden items-center gap-1.5 rounded-full border border-black/10 px-3 py-1.5 text-sm font-semibold hover:bg-[var(--swift-subtle)] sm:flex">
            <MapPin className="h-4 w-4 text-[var(--swift-red)]" /> Deliver to…
          </Link>
          <Link href="/order/search" className="ml-auto flex flex-1 items-center gap-2 rounded-full border border-black/10 px-4 py-2 text-sm text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] sm:max-w-xs">
            <Search className="h-4 w-4" /> Search Swift
          </Link>
          <Link href="/cart" aria-label="Cart" className="grid h-9 w-9 place-items-center rounded-full border border-black/10 hover:bg-[var(--swift-subtle)]">
            <ShoppingBag className="h-4.5 w-4.5" />
          </Link>
          <Link href="/account" aria-label="Account" className="grid h-9 w-9 place-items-center rounded-full border border-black/10 hover:bg-[var(--swift-subtle)]">
            <User className="h-4.5 w-4.5" />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
