'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Modal } from '@/components/Modal';
import { sessionProbe } from '@/lib/api';

/**
 * `/login` renders standalone. Every other route waits for the server to
 * attest an ADMIN or SUPER_ADMIN role before mounting the workspace.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/login';
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const close = () => { if (media.matches) setDrawer(false); };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);

  useEffect(() => {
    setReadyPath(null);
    if (isLogin) {
      return;
    }
    // [A-01] the shell gates on the SERVER's attestation of a session — not on a token's presence,
    // because there is no token to be present: the session is an HttpOnly cookie
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      const roles = session.user?.roles;
      const isAdmin = session.ok && Array.isArray(roles) && roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN');
      if (!isAdmin) router.replace('/login');
      else setReadyPath(pathname);
    });
    return () => { cancelled = true; };
  }, [isLogin, pathname, router]);

  if (isLogin) return <>{children}</>;

  if (readyPath !== pathname) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--ink)] text-[var(--muted)] text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-dvh">
      <div data-desktop-sidebar className="hidden md:flex shrink-0"><Sidebar /></div>
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden" inert={drawer ? true : undefined}>
        <Header onOpenNavigation={() => setDrawer(true)} />
        <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
      {drawer && <Modal title="Navigation" onClose={() => setDrawer(false)} className="admin-drawer" overlayTestId="navigation-overlay">
        <button className="admin-drawer-close" onClick={() => setDrawer(false)} aria-label="Close navigation">Close navigation ×</button>
        <Sidebar onNavigate={() => setDrawer(false)} />
      </Modal>}
    </div>
  );
}
