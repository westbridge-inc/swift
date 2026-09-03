'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { sessionProbe } from '@/lib/api';

/**
 * Auth gate. `/login` renders standalone; every other route requires a token —
 * without one we bounce to `/login` (the admin console is no longer reachable
 * un-authenticated).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/login';
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    // [A-01] the shell gates on the SERVER's attestation of a session — not on a token's presence,
    // because there is no token to be present: the session is an HttpOnly cookie
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      if (!session.ok) router.replace('/login');
      else setReady(true);
    });
    return () => { cancelled = true; };
  }, [isLogin, pathname, router]);

  if (isLogin) return <>{children}</>;

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--ink)] text-[var(--muted)] text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
