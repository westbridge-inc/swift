'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, History, FileCheck2, UserRound, LogOut } from 'lucide-react';
import { Providers } from '@/components/providers';
import { logout, sessionProbe } from '@/lib/auth';

const NAV = [
  { href: '/portal', label: 'Earnings', icon: LayoutDashboard, exact: true },
  { href: '/portal/history', label: 'History', icon: History, exact: false },
  { href: '/portal/documents', label: 'Documents', icon: FileCheck2, exact: false },
  { href: '/portal/account', label: 'Account', icon: UserRound, exact: false },
];

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="flex min-h-screen bg-[var(--swift-subtle)]">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-black/5 bg-white p-4">
        <Link href="/portal" className="px-2 text-lg font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> Earner
        </Link>
        <p className="mt-1 px-2 text-xs text-[var(--swift-muted)]">
          Jobs are accepted in the app — this is your office.
        </p>
        <nav className="mt-5 flex-1 space-y-1">
          {NAV.map((n) => {
            const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  active ? 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]' : 'text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]'
                }`}
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={() => {
            // the session lives in a cookie only the server can expire
            void logout().then(() => router.replace('/login'));
          }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </aside>
      <main className="ml-60 min-w-0 flex-1 p-6 lg:p-8">{children}</main>
    </div>
  );
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // [W-01] The session is an HttpOnly cookie: gate on the SERVER's word,
    // never on a token's presence, because there is no token to be present.
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      if (!session.ok) router.replace('/login');
      else setReady(true);
    });
    return () => { cancelled = true; };
  }, [router]);
  if (!ready) return null;
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
