'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, History, FileCheck2, Receipt, UserRound } from 'lucide-react';
import { Providers } from '@/components/providers';
import { ConsoleShell } from '@/components/console-shell';
import { currentSessionProof, sessionProbe } from '@/lib/auth';

export const NAV = [
  { href: '/portal', label: 'Earnings', icon: LayoutDashboard, exact: true },
  { href: '/portal/history', label: 'History', icon: History, exact: false },
  { href: '/portal/documents', label: 'Documents', icon: FileCheck2, exact: false },
  { href: '/portal/weekly-fee', label: 'Weekly fee', icon: Receipt, exact: true },
  { href: '/portal/account', label: 'Account', icon: UserRound, exact: false },
];

export function PortalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // [W-01] The session is an HttpOnly cookie: gate on the SERVER's word,
    // never on a token's presence, because there is no token to be present.
    let cancelled = false;
    void currentSessionProof(sessionProbe()).then((session) => {
      if (cancelled) return;
      if (session.signedOut) router.replace('/login');
      else if (session.ok) setReady(true);
    });
    return () => { cancelled = true; };
  }, [router]);
  if (!ready) return null;
  return (
    <Providers>
      <ConsoleShell home="/portal" title="Earner" description="Jobs are accepted in the app — this is your office."
        navigation={NAV}
        signOutBody="This signs you out of this browser only, not the Swift app on your phone. Your earnings, history and documents stay with your account.">
        {children}
      </ConsoleShell>
    </Providers>
  );
}
