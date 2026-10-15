'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Modal } from '@/components/Modal';
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
  const [role, setRole] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const close = () => { if (media.matches) setDrawer(false); };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);

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
      else { setRole(session.user?.activeRole ?? null); setReady(true); }
    });
    return () => { cancelled = true; };
  }, [isLogin, pathname, router]);

  if (isLogin) return <>{children}</>;

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm" style={{ background: 'var(--mc-paper)', color: 'var(--mc-muted)', fontFamily: 'var(--mc-font-body)' }}>
        Checking your session…
      </div>
    );
  }

  return (
    <div className="flex h-dvh">
      <div data-desktop-sidebar className="hidden md:flex shrink-0"><Sidebar role={role} /></div>
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden" inert={drawer ? true : undefined}>
        <Header onOpenNavigation={() => setDrawer(true)} />
        <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
      {drawer && <Modal title="Navigation" onClose={() => setDrawer(false)} className="admin-drawer" overlayTestId="navigation-overlay">
        <button className="admin-drawer-close" onClick={() => setDrawer(false)} aria-label="Close navigation">Close navigation ×</button>
        <Sidebar onNavigate={() => setDrawer(false)} role={role} />
      </Modal>}
    </div>
  );
}
