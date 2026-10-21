'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardList, UserRound } from 'lucide-react';
import { Providers } from '@/components/providers';
import type { ShellPerson } from '@/components/customer-shell';
import { ConsoleShell } from '@/components/console-shell';
import { subscribeSession } from '@/lib/auth';
import { ConsoleUnreachable, checkConsoleSession } from '@/components/console-session';
const NAV = [
  { href: '/advertiser', label: 'Campaigns', icon: ClipboardList, exact: false },
  { href: '/advertiser/account', label: 'Account', icon: UserRound, exact: false },
];
export function AdvertiserShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [principal, setPrincipal] = useState<string | null>(null);
  const [person, setPerson] = useState<ShellPerson | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // [UI-SWEEP U23 · REVIEW-F2 #1968 S3-1/S4-1] The same check as the other
  // consoles: an expired access cookie is restored once before /login, and a
  // check that could not reach Swift says so instead of signing out.
  useEffect(() => {
    let live = true;
    const probe = () => { void checkConsoleSession().then(s => {
      if (!live) return;
      if (s.ok) { setUnreachable(false); setPerson({ name: [s.user?.['firstName'], s.user?.['lastName']].filter(v => typeof v === 'string').join(' '), phone: null }); setPrincipal(String(s.user?.['id'])); }
      else if (s.unreachable) setUnreachable(true);
      else { setUnreachable(false); setPrincipal(null); router.replace('/login?next=%2Fadvertiser'); }
    }); };
    const unsubscribe = subscribeSession(probe); probe();
    return () => { live = false; unsubscribe(); };
  }, [router, attempt]);
  if (unreachable) return <ConsoleUnreachable onRetry={() => { setUnreachable(false); setAttempt((n) => n + 1); }} />;
  if (!principal) return <div className="sw-page sw-empty" role="status">Opening Swift Ads…</div>;
  return <Providers key={principal}><ConsoleShell person={person} home="/advertiser" title="Ads" navigation={NAV} signOutBody="Your campaigns stay with your account. This signs you out of this browser.">{children}</ConsoleShell></Providers>;
}
