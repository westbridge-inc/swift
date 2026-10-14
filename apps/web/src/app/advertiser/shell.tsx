'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardList, UserRound } from 'lucide-react';
import { Providers } from '@/components/providers';
import type { ShellPerson } from '@/components/customer-shell';
import { ConsoleShell } from '@/components/console-shell';
import { sessionProbe, subscribeSession } from '@/lib/auth';
const NAV = [
  { href: '/advertiser', label: 'Campaigns', icon: ClipboardList, exact: false },
  { href: '/advertiser/account', label: 'Account', icon: UserRound, exact: false },
];
export function AdvertiserShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [principal, setPrincipal] = useState<string | null>(null);
  const [person, setPerson] = useState<ShellPerson | null>(null);
  useEffect(() => {
    let live = true;
    const probe = () => { void sessionProbe().then(s => { if (!live) return; if (!s.ok) { setPrincipal(null); router.replace('/login?next=%2Fadvertiser'); } else { setPerson({ name: [s.user?.['firstName'], s.user?.['lastName']].filter(v => typeof v === 'string').join(' '), phone: null }); setPrincipal(String(s.user?.['id'])); } }); };
    const unsubscribe = subscribeSession(probe); probe();
    return () => { live = false; unsubscribe(); };
  }, [router]);
  if (!principal) return <div className="sw-page sw-empty" role="status">Opening Swift Ads…</div>;
  return <Providers key={principal}><ConsoleShell person={person} home="/advertiser" title="Ads" navigation={NAV} signOutBody="Your campaigns stay with your account. This signs you out of this browser.">{children}</ConsoleShell></Providers>;
}
