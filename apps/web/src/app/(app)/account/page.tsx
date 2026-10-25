'use client';

import Link from 'next/link';
import { ChevronRight, CircleHelp, FileText, LogOut, MapPin, Phone, RefreshCw, Shield, Trash2, User } from 'lucide-react';
import { SignOutButton } from '@/components/sign-out-button';
import { DataUnavailable } from '@/components/data-unavailable';
import { AccountBoundary, useAccountQuery } from '@/components/account/account-frame';
import { accountApi } from '@/components/account/account-api';
import { Avatar, useSwitchApp } from '@/components/customer-shell';
import { Pictogram } from '@/components/glyphs';
import { Bone } from '@/components/customer-skeletons';

export default function AccountPage() {
  return <AccountBoundary><Account /></AccountBoundary>;
}

/**
 * [WEB-REDESIGN] Account in the owner's design: who you are, three quick
 * tiles, the account and help rows, the legal links, "Earn with Swift", and
 * sign-out. Every row opens a real page.
 */
function Account() {
  const profile = useAccountQuery('profile', accountApi.profile);
  const openSwitchApp = useSwitchApp();
  const me = profile.data;
  const name = me ? `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() : '';

  const accountRows = [
    { href: '/account/profile', label: 'Personal details and preferences', sub: 'Your name, email and marketing messages', Icon: User },
    { href: '/account/addresses', label: 'Saved addresses', sub: 'Where Swift delivers to', Icon: MapPin },
    { href: '/account/safety', label: 'Safety', sub: 'Who Swift contacts if you raise an alert', Icon: Shield },
  ];
  const helpRows = [
    { href: '/account/help', label: 'Help', sub: 'Get help with an order or your account', Icon: CircleHelp },
    { href: '/contact', label: 'Contact us', sub: 'Phone and email for Swift support', Icon: Phone },
  ];
  const legalRows = [
    { href: '/legal/terms', label: 'Terms of service', Icon: FileText },
    { href: '/legal/privacy', label: 'Privacy policy', Icon: Shield },
    { href: '/account/delete', label: 'Delete your account', Icon: Trash2 },
  ];

  return (
    <div className="mx-auto flex max-w-[720px] flex-col">
      <span className="sw-eyebrow mb-2">Account</span>
      {profile.isError ? <DataUnavailable what="your profile" error={profile.error} onRetry={() => void profile.refetch()} />
        : !me ? (
          <div className="flex items-center gap-4" role="status" aria-label="Loading your profile"><Bone className="h-16 w-16 rounded-full" /><span className="flex flex-col gap-1"><Bone className="h-7 w-44" /><Bone className="h-[18px] w-28" /></span></div>
        ) : (
          <div className="flex items-center gap-4">
            <Avatar name={name || 'S'} size={64} />
            <div className="min-w-0 flex-1">
              <p className="sw-title truncate">{name || 'Your account'}</p>
              {me.phone ? <p className="mt-0.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">{me.phone}</p> : null}
            </div>
          </div>
        )}

      <div className="mt-5 grid grid-cols-3 gap-3">
        {[
          { href: '/orders', label: 'Orders & rides', pictogram: 'orders' as const },
          { href: '/account/favourites', label: 'Favourites', pictogram: 'favourites' as const },
          { href: '/account/help', label: 'Get help', pictogram: 'services' as const },
        ].map((tile) => (
          <Link key={tile.href} href={tile.href} className="flex flex-col items-center gap-2 rounded-2xl bg-[var(--swift-sunken)] px-1 py-4 text-center text-[13px] font-semibold leading-[18px] text-[var(--swift-ink)] active:opacity-70">
            <Pictogram name={tile.pictogram} size={22} />
            {tile.label}
          </Link>
        ))}
      </div>

      <RowGroup title="Your account" rows={accountRows} />
      <RowGroup title="Help" rows={helpRows} />
      <RowGroup title="Privacy and legal" rows={legalRows} plain />

      <button type="button" onClick={openSwitchApp} className="mt-8 flex w-full cursor-pointer items-center gap-4 rounded-2xl border-0 bg-[var(--swift-red)] p-4 text-left text-[var(--swift-white)] transition-colors hover:bg-[var(--swift-red-600)]">
        <span className="grid h-11 w-11 flex-none place-items-center rounded-full bg-[var(--swift-on-brand-muted)]"><RefreshCw size={20} aria-hidden /></span>
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="font-display text-[22px] font-semibold leading-7">Earn with Swift</span>
          <span className="text-[13px] leading-[18px]">Drive, deliver, or sell — switch to Swift Driver or Swift Business.</span>
        </span>
        <ChevronRight size={20} aria-hidden />
      </button>

      <div className="mt-6">
        <SignOutButton className="sw-btn sw-btn-block sw-btn-outline"
          body="You’ll need to sign in again to order in this browser. Your orders, addresses and cart stay with your account." redirectTo="/">
          <LogOut size={18} aria-hidden /> Sign out
        </SignOutButton>
      </div>
    </div>
  );
}

function RowGroup({ title, rows, plain = false }: { title: string; rows: { href: string; label: string; sub?: string; Icon: typeof User }[]; plain?: boolean }) {
  return (
    <section className="mt-6" aria-label={title}>
      <span className="sw-eyebrow mb-2">{title}</span>
      {rows.map(({ href, label, sub, Icon }) => (
        <Link key={href} href={href} className="sw-row">
          {plain ? null : <span className="sw-row-chip"><Icon size={16} aria-hidden /></span>}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold leading-5">{label}</span>
            {sub ? <span className="mt-0.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">{sub}</span> : null}
          </span>
          <ChevronRight size={20} className="flex-none text-[var(--swift-muted-soft)]" aria-hidden />
        </Link>
      ))}
    </section>
  );
}
