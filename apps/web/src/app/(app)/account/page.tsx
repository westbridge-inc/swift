'use client';

import Link from 'next/link';
import { Receipt, MapPin, LogOut, ChevronRight, Heart, User, CircleHelp, Shield } from 'lucide-react';
import { SignOutButton } from '@/components/sign-out-button';
import { DataUnavailable } from '@/components/data-unavailable';
import { AccountBoundary, useAccountQuery } from '@/components/account/account-frame';
import { accountApi } from '@/components/account/account-api';

export default function AccountPage() {
  return <AccountBoundary><Account /></AccountBoundary>;
}

function Account() {
  const profile = useAccountQuery('profile', accountApi.profile);
  const me = profile.data;
  const links = [
    { href: '/orders', label: 'Your orders', Icon: Receipt },
    { href: '/account/favourites', label: 'Favourites', Icon: Heart },
    { href: '/account/addresses', label: 'Saved addresses', Icon: MapPin },
    { href: '/account/profile', label: 'Personal details and preferences', Icon: User },
    { href: '/account/help', label: 'Help', Icon: CircleHelp },
    { href: '/account/safety', label: 'Safety', Icon: Shield },
  ];
  return <div className="mx-auto max-w-lg space-y-5">
    <h1 className="text-2xl font-extrabold">Your account</h1>
    <div className="rounded-2xl border border-black/5 bg-white p-5">
      {profile.isError ? <DataUnavailable what="your profile" error={profile.error} onRetry={() => void profile.refetch()} />
        : !me ? <p role="status">Loading your profile…</p>
        : <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--swift-red)] text-lg font-black text-white">{(me.firstName || 'U').charAt(0)}</span>
          <div><p className="font-extrabold">{`${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() || 'Your account'}</p><p className="text-sm text-[var(--swift-muted)]">{me.phone}</p></div>
        </div>}
    </div>
    <div className="overflow-hidden rounded-2xl border border-black/5 bg-white">{links.map(({ href, label, Icon }) => <Link key={href} href={href} className="flex items-center gap-3 border-b border-black/5 px-5 py-4 last:border-0 hover:bg-[var(--swift-subtle)]"><Icon className="h-5 w-5 text-[var(--swift-red)]" aria-hidden /><span className="flex-1 font-semibold">{label}</span><ChevronRight className="h-4 w-4 text-[var(--swift-muted)]" aria-hidden /></Link>)}</div>
    <SignOutButton className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--swift-red)] py-3 font-bold text-[var(--swift-red)]"
      body="You’ll need to sign in again to order in this browser. Your orders, addresses and cart stay with your account." redirectTo="/">
      <LogOut className="h-4 w-4" /> Sign out
    </SignOutButton>
  </div>;
}
