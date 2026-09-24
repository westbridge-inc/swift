'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ShoppingBag, User, MapPin, Search } from 'lucide-react';
import { sessionProbe } from '@/lib/auth';
import { SwiftLogo } from '@/components/swift-logo';
import { InstallPrompt } from '@/components/install-prompt';

// The customer ordering shell — search is public; private pages require a
// signed-in customer. Same HttpOnly cookie session as the partner flow; a customer just
// lands on /order instead of /dashboard.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const publicSearch = pathname === '/order/search';

  useEffect(() => {
    if (publicSearch) {
      setReadyPath(null);
      return;
    }
    // [W-01] The session is an HttpOnly cookie: gate on the SERVER's word,
    // never on a token's presence, because there is no token to be present.
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      if (!session.ok) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      else setReadyPath(pathname);
    });
    return () => { cancelled = true; };
  }, [router, pathname, publicSearch]);

  const ready = publicSearch || readyPath === pathname;
  // [PWA-1] The install card is mounted from the first render, outside the
  // sign-in gate — both returns keep it second in the same fragment, so React
  // keeps its state. The browser's install event can arrive while the session
  // check is still in flight; a card mounted after the gate would miss it. It
  // is shown on the home page only, never over a cart, checkout or live order.
  const installPrompt = <InstallPrompt enabled={ready && pathname === '/order'} />;

  if (!ready) {
    return (
      <>
        <div className="grid min-h-screen place-items-center text-[var(--swift-muted)]">Loading…</div>
        {installPrompt}
      </>
    );
  }

  // [PWA-1] Installed on an iPhone, the app runs edge to edge: the header pads
  // below any status bar drawn over it and the page ends above the home bar.
  // Both insets are zero in an ordinary browser tab.
  return (
    <>
      <div className="min-h-screen">
        <header className="sticky top-0 z-30 border-b border-black/5 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
            <Link href="/order" aria-label="Swift home"><SwiftLogo /></Link>
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
        <main className="mx-auto max-w-6xl px-4 pt-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))]">{children}</main>
      </div>
      {installPrompt}
    </>
  );
}
