'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Modal } from '@/components/Modal';
import { sessionProbe } from '@/lib/api';

/**
 * Auth gate. `/login` renders standalone. [L06 #1556] Every other route waits,
 * on EACH page, for the server to attest an ADMIN or SUPER_ADMIN role before
 * the workspace mounts; anything else goes to `/login`. The page cache belongs
 * to one signed-in admin: it is dropped on the way to `/login` and whenever the
 * attested account changes, before any page mounts again, so one account never
 * sees another account's cached answers (ASTRA S1).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/login';
  const [readyPath, setReadyPath] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const attested = useRef<string | null>(null);
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
    setReadyPath(null);
    if (isLogin) {
      dropSessionCache();
      return;
    }
    // [A-01] the shell gates on the SERVER's attestation of a session — not on a token's presence,
    // because there is no token to be present: the session is an HttpOnly cookie
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      const user = session.ok ? session.user : undefined;
      const roles = user?.roles;
      const isAdmin = Array.isArray(roles) && roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN');
      if (!user || !isAdmin) { dropSessionCache(); router.replace('/login'); return; }
      if (attested.current !== null && attested.current !== user.id) dropSessionCache();
      attested.current = user.id;
      setRole(user.activeRole ?? null);
      setReadyPath(pathname);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dropSessionCache reads only refs + the stable client
  }, [isLogin, pathname, router]);

  /** Cancel in-flight reads and forget every cached answer of the previous session. */
  function dropSessionCache() {
    attested.current = null;
    void queryClient.cancelQueries();
    queryClient.clear();
  }

  if (isLogin) return <>{children}</>;

  if (readyPath !== pathname) {
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
