'use client';

import { LayoutDashboard, History, FileCheck2, Receipt, UserRound } from 'lucide-react';
import { Providers } from '@/components/providers';
import { ConsoleUnreachable, useConsoleSession } from '@/components/console-session';
import { ConsoleShell } from '@/components/console-shell';

export const NAV = [
  { href: '/portal', label: 'Earnings', icon: LayoutDashboard, exact: true },
  { href: '/portal/history', label: 'History', icon: History, exact: false, dock: false },
  { href: '/portal/documents', label: 'Documents', icon: FileCheck2, exact: false },
  { href: '/portal/weekly-fee', label: 'Weekly fee', icon: Receipt, exact: true },
  { href: '/portal/account', label: 'Account', icon: UserRound, exact: false },
];

export function PortalShell({ children }: { children: React.ReactNode }) {
  // [W-01 · UI-SWEEP U23] Only the server saying "no session" goes to /login;
  // a check that could not reach Swift says so instead (components/console-session).
  const gate = useConsoleSession();
  if (gate.phase === 'unreachable') return <ConsoleUnreachable onRetry={gate.retry} />;
  if (gate.phase !== 'ready') return <div className="sw-page sw-empty" role="status">Opening your office…</div>;
  const person = gate.person;
  return (
    <Providers offline="fail">
      <ConsoleShell person={person} home="/portal" title="Earner" description="Jobs are accepted in the app — this is your office."
        navigation={NAV}
        signOutBody="This signs you out of this browser only, not the Swift app on your phone. Your earnings, history and documents stay with your account.">
        {children}
      </ConsoleShell>
    </Providers>
  );
}
